use serde::Serialize;
use serde_json::{Value, json};
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const DEFAULTS: &str = include_str!("../../config/desktop-defaults.json");
const MAX_JSON_BYTES: usize = 20 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeError {
    code: &'static str,
    message: String,
}

impl std::fmt::Display for NativeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for NativeError {}
impl From<std::io::Error> for NativeError {
    fn from(error: std::io::Error) -> Self {
        Self {
            code: "io",
            message: error.to_string(),
        }
    }
}
fn error(code: &'static str, message: impl Into<String>) -> NativeError {
    NativeError {
        code,
        message: message.into(),
    }
}
pub fn benchmark_mode() -> bool {
    std::env::var("TC_BENCH_DISABLE_INTEGRATIONS").as_deref() == Ok("1")
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct HostState {
    pub profile_root: PathBuf,
    pub data_dir: PathBuf,
    settings: Mutex<Value>,
    pub inventory: Result<crate::inventory::InventoryService, String>,
    pub startup_issues: Vec<String>,
    settings_read_error: bool,
}

impl HostState {
    pub fn open(app: &tauri::AppHandle) -> Result<Self, NativeError> {
        let args: Vec<_> = std::env::args().collect();
        let supplied = args
            .iter()
            .find_map(|a| a.strip_prefix("--profile-dir=").map(str::to_owned))
            .or_else(|| {
                args.windows(2)
                    .find(|a| a[0] == "--profile-dir")
                    .map(|a| a[1].clone())
            });
        if benchmark_mode() && supplied.is_none() {
            return Err(error(
                "benchmark_profile",
                "Benchmark mode requires an explicit isolated --profile-dir",
            ));
        }
        let data_dir = match supplied {
            Some(value) => {
                let path = PathBuf::from(value);
                if !path.is_absolute() {
                    return Err(error(
                        "invalid_profile",
                        "Profile directory must be absolute",
                    ));
                }
                path
            }
            None => app
                .path()
                .app_data_dir()
                .map_err(|e| error("profile_path", e.to_string()))?,
        };
        fs::create_dir_all(&data_dir)?;
        let profile_root = data_dir.canonicalize()?;
        let mut startup_issues = Vec::new();
        let data_dir = crate::backup::active_profile(&profile_root).unwrap_or_else(|message| {
            startup_issues.push(format!(
                "Recovered profile could not be opened: {message}. Original profile retained."
            ));
            profile_root.clone()
        });
        let mut settings: Value =
            serde_json::from_str(DEFAULTS).map_err(|e| error("defaults", e.to_string()))?;
        let file = data_dir.join("settings.json");
        let mut settings_read_error = false;
        if file.exists() {
            let read = || -> Result<Value, String> {
                if fs::metadata(&file).map_err(|e| e.to_string())?.len() > MAX_JSON_BYTES as u64 {
                    return Err("Settings file is too large".into());
                }
                let saved: Value =
                    serde_json::from_slice(&fs::read(&file).map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                if !saved.is_object() {
                    return Err("Settings must contain an object".into());
                }
                Ok(saved)
            };
            let saved = read().unwrap_or_else(|message| {
                settings_read_error = true;
                startup_issues.push(format!("Settings could not be read: {message}. Original file retained; settings writes are disabled until recovery."));
                Value::Null
            });
            // Only recognized settings with the expected primitive type are restored.
            if let (Some(current), Some(saved)) = (settings.as_object_mut(), saved.as_object()) {
                for (key, value) in saved {
                    if let Some(default) = current.get(key)
                        && compatible(key, default, value)
                    {
                        current.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        // A saved file must not bypass the same migration gates as settings IPC.
        for key in [
            "startWithWindows",
            "searchBar",
            "clearPositionShots",
            "cleanAfterUpdate",
        ] {
            settings[key] = Value::Bool(false);
        }
        settings["updateMode"] = Value::String("off".into());
        if !settings["backupKeep"]
            .as_u64()
            .is_some_and(|n| (1..=30).contains(&n))
        {
            settings["backupKeep"] = Value::from(7);
        }
        let inventory = crate::inventory::InventoryService::open(data_dir.join("user.sqlite"));
        if let Err(message) = &inventory {
            startup_issues.push(format!("Inventory could not be opened: {message}. Use full backup recovery; the current database is retained."));
        }
        Ok(Self {
            profile_root,
            data_dir,
            settings: Mutex::new(settings),
            inventory,
            startup_issues,
            settings_read_error,
        })
    }

    pub fn settings(&self) -> Result<Value, NativeError> {
        self.settings
            .lock()
            .map(|s| s.clone())
            .map_err(|_| error("settings_lock", "Settings lock unavailable"))
    }

    fn public_settings(&self) -> Result<Value, NativeError> {
        let mut value = self.settings()?;
        for key in [
            "window",
            "lastCleanedVersion",
            "trayNoticeShown",
            "searchBarPos",
        ] {
            value.as_object_mut().unwrap().remove(key);
        }
        Ok(value)
    }

    fn update_settings(&self, patch: &Value) -> Result<Value, NativeError> {
        if self.settings_read_error {
            return Err(error(
                "settings_recovery",
                "Settings could not be read. Restore a full backup before saving settings; the original file is retained.",
            ));
        }
        let patch = patch
            .as_object()
            .ok_or_else(|| error("invalid_settings", "Settings patch must be an object"))?;
        let public = self.public_settings()?;
        let mut guard = self
            .settings
            .lock()
            .map_err(|_| error("settings_lock", "Settings lock unavailable"))?;
        let mut next = guard.clone();
        for (key, value) in patch {
            let current = public
                .get(key)
                .ok_or_else(|| error("invalid_settings", format!("Unknown setting: {key}")))?;
            if !compatible(key, current, value) {
                return Err(error(
                    "invalid_settings",
                    format!("Invalid value for {key}"),
                ));
            }
            if matches!(key.as_str(), "searchBar" | "startWithWindows")
                && value.as_bool() == Some(true)
            {
                return Err(error(
                    "migration_pending",
                    "This native integration is still being migrated. Use the Electron build for this feature.",
                ));
            }
            if key == "updateMode" && value != "off" {
                return Err(error(
                    "updates_disabled",
                    "Fork updates are disabled until the release channel is verified",
                ));
            }
            if matches!(key.as_str(), "clearPositionShots" | "cleanAfterUpdate") && value == true {
                return Err(error(
                    "migration_pending",
                    "Screenshot cleanup is disabled during native migration",
                ));
            }
            if key == "backupKeep" && !value.as_u64().is_some_and(|n| (1..=30).contains(&n)) {
                return Err(error("invalid_settings", "Keep between 1 and 30 backups"));
            }
            if key == "logsPath"
                && let Some(value) = value.as_str()
            {
                safe_directory(value)?;
            }
            next[key] = value.clone();
        }
        atomic_write(
            &self.data_dir.join("settings.json"),
            &serde_json::to_vec_pretty(&next).map_err(|e| error("settings_json", e.to_string()))?,
        )?;
        *guard = next;
        drop(guard);
        self.public_settings()
    }
}

fn compatible(key: &str, default: &Value, value: &Value) -> bool {
    if key == "searchBarPos" {
        return value.is_null()
            || value.as_object().is_some_and(|v| {
                v.len() == 2
                    && ["x", "y"]
                        .iter()
                        .all(|key| v.get(*key).is_some_and(|n| n.as_i64().is_some()))
            });
    }
    if matches!(
        key,
        "logsPath" | "knownProfileId" | "knownGameVersion" | "lastCleanedVersion"
    ) || default.is_null()
    {
        return value.is_null() || value.as_str().is_some_and(|v| v.len() <= 4096);
    }
    (default.is_boolean() && value.is_boolean())
        || (default.is_number() && value.is_number())
        || (default.is_string() && value.as_str().is_some_and(|v| v.len() <= 4096))
        || (default.is_object() && value.is_object())
}

pub(crate) fn atomic_write(file: &Path, bytes: &[u8]) -> Result<(), NativeError> {
    static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let suffix = SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temporary = file.with_extension(format!("{}.{}.pending", std::process::id(), suffix));
    let mut output = File::options()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    output.write_all(bytes)?;
    output.sync_all()?;
    drop(output);
    fs::rename(temporary, file)?;
    Ok(())
}

fn safe_directory(value: &str) -> Result<PathBuf, NativeError> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || !path.is_dir() {
        return Err(error(
            "invalid_directory",
            "Choose an existing absolute directory",
        ));
    }
    Ok(path.canonicalize()?)
}

fn screenshot_dir(app: &tauri::AppHandle) -> Result<PathBuf, NativeError> {
    app.path()
        .document_dir()
        .map(|p| p.join("Escape from Tarkov").join("Screenshots"))
        .map_err(|e| error("screenshots_path", e.to_string()))
}
fn plain_image_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.contains(['/', '\\', ':'])
        && !name.starts_with('.')
        && Path::new(name)
            .extension()
            .and_then(|p| p.to_str())
            .is_some_and(|e| {
                ["png", "jpg", "jpeg", "bmp"].contains(&e.to_ascii_lowercase().as_str())
            })
}
fn backup_path(state: &HostState, name: &str) -> Result<PathBuf, NativeError> {
    if !name
        .strip_prefix("backup-")
        .and_then(|name| name.strip_suffix(".json"))
        .is_some_and(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
    {
        return Err(error("backup_name", "Invalid backup filename"));
    }
    Ok(state.data_dir.join("backups").join(name))
}
fn backup_list(state: &HostState) -> Result<Value, NativeError> {
    let dir = state.data_dir.join("backups");
    if !dir.exists() {
        return Ok(json!([]));
    }
    let mut rows = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if backup_path(state, &name).is_err() || !entry.file_type()?.is_file() {
            continue;
        }
        let metadata = entry.metadata()?;
        let at = metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        rows.push(json!({"name":name,"at":at,"size":metadata.len()}));
    }
    rows.sort_by_key(|v| std::cmp::Reverse(v["at"].as_u64().unwrap_or(0)));
    Ok(json!(rows))
}

#[tauri::command]
pub fn desktop_metadata(window: tauri::WebviewWindow) -> Value {
    json!({"platform": if cfg!(windows) {"win32"} else {std::env::consts::OS}, "appVersion": env!("CARGO_PKG_VERSION"), "windowKind": if window.label()=="searchbar" {"searchbar"} else {"main"}})
}

#[tauri::command]
pub async fn desktop_call(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, NativeError> {
    if !["main", "searchbar"].contains(&window.label()) {
        return Err(error("window", "Unrecognized application window"));
    }
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || dispatch(&app, &window, &state, &channel, &args))
        .await
        .map_err(|e| error("native_job", e.to_string()))?
}

fn dispatch(
    app: &tauri::AppHandle,
    _window: &tauri::WebviewWindow,
    state: &HostState,
    channel: &str,
    args: &[Value],
) -> Result<Value, NativeError> {
    let first = args.first().unwrap_or(&Value::Null);
    match channel {
        "ui:ready" => {
            if benchmark_mode()
                && let Ok(value) = std::env::var("TC_BENCH_READY_FILE")
            {
                let path = PathBuf::from(value);
                let root = state
                    .data_dir
                    .parent()
                    .ok_or_else(|| error("benchmark_output", "No measurement directory"))?
                    .canonicalize()?;
                if path.parent().and_then(|p| p.canonicalize().ok()).as_ref() != Some(&root) {
                    return Err(error(
                        "benchmark_output",
                        "Ready file must belong to the isolated measurement directory",
                    ));
                }
                if !path.exists() {
                    atomic_write(
                        &path,
                        &serde_json::to_vec(
                            &json!({"milestone":"react-layout-mounted","at":now_ms()}),
                        )
                        .map_err(|e| error("benchmark_output", e.to_string()))?,
                    )?;
                }
            }
            Ok(Value::Null)
        }
        "settings:get" => state.public_settings(),
        "settings:set" => {
            let value = state.update_settings(first)?;
            app.emit("settings-changed", &value)
                .map_err(|e| error("event", e.to_string()))?;
            Ok(value)
        }
        "watcher:getState" => Ok(
            json!({"status":"no-folder","logsPath":state.settings()?["logsPath"],"detectedPath":null,"currentFolder":null,"lastEventAt":null,"sessionMode":"unknown","profileId":null,"accountId":null,"message":"Native log synchronization is being migrated. The Electron build remains available for log tracking."}),
        ),
        "watcher:recent" => Ok(json!([])),
        "watcher:pickFolder" => {
            let selected = app.dialog().file().blocking_pick_folder();
            match selected {
                None => Ok(Value::Null),
                Some(path) => {
                    let path = path
                        .into_path()
                        .map_err(|e| error("directory", e.to_string()))?;
                    let path = safe_directory(&path.to_string_lossy())?;
                    state.update_settings(&json!({"logsPath":path.to_string_lossy()}))?;
                    Ok(json!(path.to_string_lossy()))
                }
            }
        }
        "shell:openExternal" => {
            let text = first
                .as_str()
                .ok_or_else(|| error("url", "URL must be a string"))?;
            let url = url::Url::parse(text).map_err(|e| error("url", e.to_string()))?;
            if !matches!(url.scheme(), "http" | "https")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err(error("url", "Only ordinary web URLs can be opened"));
            }
            app.opener()
                .open_url(text, None::<&str>)
                .map_err(|e| error("open_url", e.to_string()))?;
            Ok(Value::Null)
        }
        "watcher:openFolder" | "backup:openFolder" => {
            let path = if channel == "backup:openFolder" {
                let dir = state.data_dir.join("backups");
                fs::create_dir_all(&dir)?;
                dir
            } else {
                let settings = state.settings()?;
                safe_directory(
                    settings["logsPath"]
                        .as_str()
                        .ok_or_else(|| error("directory", "Choose a logs folder first"))?,
                )?
            };
            app.opener()
                .open_path(path.to_string_lossy(), None::<&str>)
                .map_err(|e| error("open_path", e.to_string()))?;
            Ok(Value::Null)
        }
        "scan:listShots" => {
            let dir = screenshot_dir(app)?;
            if !dir.exists() {
                return Ok(json!([]));
            }
            let mut shots = Vec::new();
            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !plain_image_name(&name) || !entry.file_type()?.is_file() {
                    continue;
                }
                let modified = entry
                    .metadata()?
                    .modified()?
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                shots.push(json!({"name":name,"modified":modified}));
            }
            shots.sort_by_key(|s| std::cmp::Reverse(s["modified"].as_u64().unwrap_or(0)));
            shots.truncate(12);
            Ok(json!(shots))
        }
        "backup:list" => backup_list(state),
        "backup:read" => {
            let name = first
                .as_str()
                .ok_or_else(|| error("backup_name", "Backup name must be a string"))?;
            let path = backup_path(state, name)?;
            if fs::metadata(&path)?.len() > MAX_JSON_BYTES as u64 {
                return Err(error("backup_size", "Backup is too large"));
            }
            Ok(json!(fs::read_to_string(path)?))
        }
        "backup:write" => {
            let text = first
                .as_str()
                .ok_or_else(|| error("backup_json", "Backup must be JSON text"))?;
            if text.len() > MAX_JSON_BYTES {
                return Err(error("backup_size", "Backup is too large"));
            }
            let value: Value =
                serde_json::from_str(text).map_err(|e| error("backup_json", e.to_string()))?;
            if !value.is_object() {
                return Err(error("backup_json", "Backup must contain an object"));
            }
            fs::create_dir_all(state.data_dir.join("backups"))?;
            let at = now_ms();
            let name = format!("backup-{at}.json");
            atomic_write(&backup_path(state, &name)?, text.as_bytes())?;
            // Retention touches only validated files in this fork's own backup directory.
            let keep = state.settings()?["backupKeep"]
                .as_u64()
                .unwrap_or(7)
                .clamp(1, 30) as usize;
            if let Some(rows) = backup_list(state)?.as_array() {
                for row in rows.iter().skip(keep) {
                    if let Some(name) = row["name"].as_str() {
                        fs::remove_file(backup_path(state, name)?)?;
                    }
                }
            }
            Ok(json!({"name":name,"at":at,"size":text.len()}))
        }
        "update:status" | "update:check" => Ok(
            json!({"state":"disabled","message":"Fork updates are disabled until the release channel is verified."}),
        ),
        "update:outcome" | "cleanup:last" => Ok(Value::Null),
        _ => Err(error(
            "migration_pending",
            format!(
                "Desktop operation {channel} has not yet been migrated. Use the Electron build for this feature."
            ),
        )),
    }
}

#[tauri::command]
pub async fn read_game_screenshot(
    app: tauri::AppHandle,
    name: String,
) -> Result<tauri::ipc::Response, NativeError> {
    if !plain_image_name(&name) {
        return Err(error("screenshot_name", "Invalid screenshot filename"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let root = screenshot_dir(&app)?.canonicalize()?;
        let path = root.join(name).canonicalize()?;
        if !path.starts_with(&root) {
            return Err(error(
                "screenshot_scope",
                "Screenshot is outside the allowed directory",
            ));
        }
        if fs::metadata(&path)?.len() > 64 * 1024 * 1024 {
            return Err(error("screenshot_size", "Screenshot is too large"));
        }
        Ok(tauri::ipc::Response::new(fs::read(path)?))
    })
    .await
    .map_err(|e| error("screenshot_job", e.to_string()))?
}

#[tauri::command]
pub async fn capture_screen() -> Result<tauri::ipc::Response, NativeError> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::capture::capture_screen_under_cursor()
            .map(tauri::ipc::Response::new)
            .map_err(|message| error("capture", message))
    })
    .await
    .map_err(|e| error("capture_job", e.to_string()))?
}

#[tauri::command]
pub async fn archive_screenshot(
    state: tauri::State<'_, Arc<HostState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, NativeError> {
    use sha2::{Digest, Sha256};
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes)
            if !bytes.is_empty() && bytes.len() <= 64 * 1024 * 1024 =>
        {
            bytes.clone()
        }
        _ => {
            return Err(error(
                "screenshot_body",
                "Provide a binary screenshot no larger than 64 MiB",
            ));
        }
    };
    let dir = state.data_dir.join("screenshots");
    tauri::async_runtime::spawn_blocking(move || {
        // Inspect dimensions before decoding to bound hostile/imported images.
        let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|e| error("screenshot_format", e.to_string()))?;
        let (width, height) = reader
            .into_dimensions()
            .map_err(|e| error("screenshot_format", e.to_string()))?;
        if u64::from(width) * u64::from(height) > 40_000_000 {
            return Err(error(
                "screenshot_size",
                "Screenshot exceeds the pixel budget",
            ));
        }
        let hash = format!("{:x}", Sha256::digest(&bytes));
        fs::create_dir_all(&dir)?;
        let destination = dir.join(&hash);
        if destination.exists() {
            let existing = fs::read(&destination)?;
            if format!("{:x}", Sha256::digest(&existing)) != hash {
                return Err(error(
                    "screenshot_corrupt",
                    "Archived screenshot failed its checksum",
                ));
            }
        } else {
            atomic_write(&destination, &bytes)?;
        }
        Ok(hash)
    })
    .await
    .map_err(|e| error("archive_job", e.to_string()))?
}

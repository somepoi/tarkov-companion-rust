use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
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

#[derive(Default)]
struct OverlayState {
    epoch: u64,
    state: Option<Value>,
    events: VecDeque<Value>,
    error: Option<String>,
}

pub struct HostState {
    pub profile_root: PathBuf,
    pub data_dir: PathBuf,
    settings: Mutex<Value>,
    pub inventory: Result<crate::inventory::InventoryService, String>,
    pub startup_issues: Vec<String>,
    settings_read_error: bool,
    pub integrations: crate::integrations::Integrations,
    pub logs: crate::logs::Logs,
    pub positions: crate::position::Positions,
    pub searchbar: crate::searchbar::SearchBar,
    overlay: Mutex<OverlayState>,
    pub packs: Result<crate::packs::Packs, String>,
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
        settings["nativeLogProfiles"] = json!({});
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
        settings["cleanAfterUpdate"] = Value::Bool(false);
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
        let packs = crate::packs::Packs::new(
            data_dir.clone(),
            include_str!(concat!(env!("OUT_DIR"), "/packs-manifest.json")),
            env!("CARGO_PKG_VERSION"),
        );
        if let Err(message) = &packs {
            startup_issues.push(format!("Content packs unavailable: {message}"));
        }
        if !startup_issues.is_empty() {
            settings["clearPositionShots"] = json!(false);
            settings["searchBar"] = json!(false);
        }
        Ok(Self {
            profile_root,
            data_dir,
            settings: Mutex::new(settings),
            inventory,
            startup_issues,
            settings_read_error,
            integrations: crate::integrations::Integrations::default(),
            logs: crate::logs::Logs::default(),
            packs,
            positions: crate::position::Positions::default(),
            searchbar: crate::searchbar::SearchBar::default(),
            overlay: Mutex::new(OverlayState::default()),
        })
    }

    pub fn settings(&self) -> Result<Value, NativeError> {
        self.settings
            .lock()
            .map(|s| s.clone())
            .map_err(|_| error("settings_lock", "Settings lock unavailable"))
    }

    fn configure_positions(
        &self,
        app: &tauri::AppHandle,
        settings: &Value,
    ) -> Result<Value, NativeError> {
        let root = if benchmark_mode() {
            PathBuf::new()
        } else {
            screenshot_dir(app)?
        };
        self.positions
            .configure(app, settings, root)
            .map_err(|e| error("position", e))
    }

    fn public_settings(&self) -> Result<Value, NativeError> {
        let mut value = self.settings()?;
        for key in [
            "window",
            "lastCleanedVersion",
            "trayNoticeShown",
            "searchBarPos",
            "nativeLogProfiles",
        ] {
            value.as_object_mut().unwrap().remove(key);
        }
        Ok(value)
    }

    fn update_settings(&self, app: &tauri::AppHandle, patch: &Value) -> Result<Value, NativeError> {
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
            if key == "updateMode" && value != "off" {
                return Err(error(
                    "updates_disabled",
                    "Fork updates are disabled until the release channel is verified",
                ));
            }
            if key == "cleanAfterUpdate" && value == true {
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
        let integration_changed = [
            "scanHotkey",
            "startWithWindows",
            "searchBar",
            "searchBarHotkey",
            "searchBarSearchHotkey",
            "searchBarLockHotkey",
            "searchBarMapHotkey",
        ]
        .iter()
        .any(|key| next[*key] != guard[*key]);
        let overlay_changed = next["searchBar"] != guard["searchBar"];
        if integration_changed {
            self.integrations
                .apply(app, &next, &self.profile_root)
                .map_err(|e| error("desktop_integration", e))?;
        }
        let position_changed = ["trackPosition", "clearPositionShots", "paused", "logsPath"]
            .iter()
            .any(|key| next[*key] != guard[*key]);
        let position_applied = if position_changed {
            self.configure_positions(app, &next).map(|_| ())
        } else {
            Ok(())
        };
        let saved = position_applied.and_then(|_| {
            if overlay_changed {
                self.searchbar
                    .apply(app, &next, &self.data_dir)
                    .map_err(|e| error("searchbar", e))?;
            }
            atomic_write(
                &self.data_dir.join("settings.json"),
                &serde_json::to_vec_pretty(&next)
                    .map_err(|e| error("settings_json", e.to_string()))?,
            )
        });
        if let Err(cause) = saved {
            let mut failures = Vec::new();
            if overlay_changed
                && let Err(rollback) = self.searchbar.apply(app, &guard, &self.data_dir)
            {
                failures.push(format!("Searchbar rollback failed: {rollback}"));
            }
            if position_changed && let Err(rollback) = self.configure_positions(app, &guard) {
                let mut disabled = guard.clone();
                disabled["trackPosition"] = json!(false);
                disabled["clearPositionShots"] = json!(false);
                let stopped = self.configure_positions(app, &disabled);
                failures.push(format!(
                    "Position rollback failed: {rollback}; tracking stop: {stopped:?}"
                ));
            }
            if integration_changed
                && let Err(rollback) = self.integrations.apply(app, &guard, &self.profile_root)
            {
                failures.push(format!("Desktop integration rollback failed: {rollback}"));
            }
            if !failures.is_empty() {
                return Err(error(
                    "settings_rollback",
                    format!("{cause}; {}", failures.join("; ")),
                ));
            }
            return Err(cause);
        }
        let logs_changed =
            next["logsPath"] != guard["logsPath"] || next["paused"] != guard["paused"];
        *guard = next;
        drop(guard);
        if logs_changed {
            self.logs
                .configure(app, &self.settings()?, false)
                .map_err(|e| error("logs", e))?;
        }
        self.public_settings()
    }

    pub fn apply_overlay_settings(&self, app: &tauri::AppHandle) -> Result<(), String> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| "Settings lock unavailable")?;
        self.searchbar.apply(app, &settings, &self.data_dir)
    }
    pub fn minimize_to_tray(&self) -> bool {
        self.settings
            .try_lock()
            .ok()
            .and_then(|settings| settings["minimizeToTray"].as_bool())
            .unwrap_or(true)
    }
    pub fn report_overlay_error(&self, app: &tauri::AppHandle, message: String) {
        if let Ok(mut overlay) = self.overlay.lock() {
            overlay.error = Some(message.clone());
        }
        let _ = app.emit("searchbar-error", message);
    }
    fn save_overlay_anchor(&self, value: Value) -> Result<(), NativeError> {
        if self.settings_read_error {
            return Err(error(
                "settings_recovery",
                "Settings require recovery before saving position",
            ));
        }
        let mut settings = self
            .settings
            .lock()
            .map_err(|_| error("settings_lock", "Settings lock unavailable"))?;
        let mut next = settings.clone();
        next["searchBarPos"] = value;
        atomic_write(
            &self.data_dir.join("settings.json"),
            &serde_json::to_vec_pretty(&next).map_err(|e| error("settings_json", e.to_string()))?,
        )?;
        *settings = next;
        Ok(())
    }
    fn log_identity(&self, app: &tauri::AppHandle, event: &Value) -> Result<Value, NativeError> {
        if self.settings_read_error {
            return Err(error(
                "settings_recovery",
                "Log identity could not be saved because settings require recovery",
            ));
        }
        let mut guard = self
            .settings
            .lock()
            .map_err(|_| error("settings_lock", "Settings lock unavailable"))?;
        let mut next = guard.clone();
        let (reason, previous, current) = match event["kind"].as_str() {
            Some("profile") => {
                let mode = event["mode"]
                    .as_str()
                    .filter(|m| ["pve", "regular", "seasonal"].contains(m));
                let Some(mode) = mode else {
                    return Ok(Value::Null);
                };
                let profile = event["profileId"]
                    .as_str()
                    .filter(|p| {
                        !p.is_empty()
                            && p.len() <= 128
                            && p.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    })
                    .ok_or_else(|| error("log_identity", "Invalid game profile identity"))?;
                let previous = next["nativeLogProfiles"][mode].as_str().map(str::to_owned);
                if previous.as_deref() == Some(profile) {
                    return Ok(Value::Null);
                }
                next["nativeLogProfiles"][mode] = json!(profile);
                ("profile", previous, profile.to_owned())
            }
            Some("gameVersion") => {
                let version = event["version"]
                    .as_str()
                    .filter(|v| {
                        !v.is_empty()
                            && v.len() <= 128
                            && v.bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_')
                    })
                    .ok_or_else(|| error("log_identity", "Invalid game version"))?;
                let previous = next["knownGameVersion"].as_str().map(str::to_owned);
                if previous.as_deref() == Some(version) {
                    return Ok(Value::Null);
                }
                next["knownGameVersion"] = json!(version);
                let major = |v: &str| v.split('.').take(2).collect::<Vec<_>>().join(".");
                (
                    "version",
                    previous.filter(|p| major(p) != major(version)),
                    version.to_owned(),
                )
            }
            _ => return Err(error("log_identity", "Unsupported log identity event")),
        };
        atomic_write(
            &self.data_dir.join("settings.json"),
            &serde_json::to_vec_pretty(&next).map_err(|e| error("settings_json", e.to_string()))?,
        )?;
        *guard = next;
        drop(guard);
        if let Some(previous) = previous {
            app.emit(
                "wipe-detected",
                json!({"reason":reason,"previous":previous,"current":current}),
            )
            .map_err(|e| error("event", e.to_string()))?;
        }
        Ok(Value::Null)
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

fn safe_app_route(to: &str) -> bool {
    if to.len() > 300 || !to.starts_with('/') {
        return false;
    }
    let (path, query) = to
        .split_once('?')
        .map_or((to, ""), |(path, query)| (path, query));
    [
        "/", "/flea", "/keys", "/quests", "/items", "/ammo", "/hideout", "/maps", "/story",
    ]
    .contains(&path)
        && query
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_%=&.+-".contains(&byte))
}
fn dispatch(
    app: &tauri::AppHandle,
    _window: &tauri::WebviewWindow,
    state: &HostState,
    channel: &str,
    args: &[Value],
) -> Result<Value, NativeError> {
    let first = args.first().unwrap_or(&Value::Null);
    if matches!(
        channel,
        "settings:set"
            | "position:connect"
            | "position:event"
            | "position:reset"
            | "watcher:relay"
            | "watcher:relayState"
    ) && _window.label() != "main"
    {
        return Err(error(
            "window",
            "Only the main window can configure native tracking",
        ));
    }
    if channel.starts_with("searchbar:") {
        if channel == "searchbar:lastError" {
            return Ok(json!(
                state
                    .overlay
                    .lock()
                    .map_err(|_| error("overlay_lock", "Overlay state unavailable"))?
                    .error
            ));
        }
        if channel == "searchbar:reportError" {
            let message = first
                .as_str()
                .filter(|text| text.len() <= 2048)
                .ok_or_else(|| error("searchbar", "Invalid error message"))?;
            state.report_overlay_error(app, message.to_owned());
            return Ok(Value::Null);
        }
        if _window.label() != "searchbar" {
            return Err(error("window", "Only the searchbar can control its window"));
        }
        if channel == "searchbar:open" {
            let to = first
                .as_str()
                .filter(|to| safe_app_route(to))
                .ok_or_else(|| error("app_route", "Invalid application route"))?;
            if let Some(main) = app.get_webview_window("main") {
                main.show().map_err(|e| error("window", e.to_string()))?;
                main.unminimize()
                    .map_err(|e| error("window", e.to_string()))?;
                main.set_focus()
                    .map_err(|e| error("window", e.to_string()))?;
                main.emit("app-open", to)
                    .map_err(|e| error("event", e.to_string()))?;
            }
            return Ok(Value::Null);
        }
        let value = state
            .searchbar
            .command(app, channel, args)
            .map_err(|message| {
                state.report_overlay_error(app, message.clone());
                error("searchbar", message)
            })?;
        if matches!(
            channel,
            "searchbar:moved" | "searchbar:home" | "searchbar:corner"
        ) {
            state.save_overlay_anchor(value.clone())?;
        }
        return Ok(value);
    }
    match channel {
        "position:connect" => {
            let settings = state
                .settings
                .lock()
                .map_err(|_| error("settings_lock", "Settings lock unavailable"))?;
            state.configure_positions(app, &settings)
        }
        "position:latest" => {
            serde_json::to_value(state.positions.latest().map_err(|e| error("position", e))?)
                .map_err(|e| error("position", e.to_string()))
        }
        "position:event" => {
            let _settings = state
                .settings
                .lock()
                .map_err(|_| error("settings_lock", "Settings lock unavailable"))?;
            if first.to_string().len() > 16 * 1024 {
                return Err(error("position", "Position event exceeds size limit"));
            }
            state
                .positions
                .note_game_event(first)
                .map_err(|e| error("position", e))?;
            Ok(Value::Null)
        }
        "position:reset" => {
            state.positions.revoke().map_err(|e| error("position", e))?;
            Ok(Value::Null)
        }
        "packs:ensure" => {
            if benchmark_mode() {
                return Err(error(
                    "packs",
                    "Pack installation is unavailable in benchmark mode",
                ));
            }
            let name = first
                .as_str()
                .filter(|name| matches!(*name, "scan" | "lighthouse"))
                .ok_or_else(|| error("packs", "Unknown content pack"))?;
            let packs = state
                .packs
                .as_ref()
                .map_err(|e| error("packs", e.clone()))?;
            if !packs.enabled() || !packs.contains(name) {
                return Err(error(
                    "packs",
                    "No downloadable content pack is described by this build. Prepare bundled scanner/map assets first.",
                ));
            }
            packs
                .ensure(name, |progress| {
                    let _ = app.emit("pack-progress", progress);
                })
                .map_err(|e| error("packs", e))?;
            Ok(Value::Null)
        }
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
            let value = state.update_settings(app, first)?;
            app.emit("settings-changed", &value)
                .map_err(|e| error("event", e.to_string()))?;
            Ok(value)
        }
        "watcher:getState" => {
            let native = state.logs.status().map_err(|e| error("logs", e))?;
            if _window.label() == "searchbar" {
                let overlay = state
                    .overlay
                    .lock()
                    .map_err(|_| error("overlay_lock", "Overlay state unavailable"))?;
                if overlay.epoch == native["epoch"].as_u64().unwrap_or(0)
                    && let Some(value) = &overlay.state
                {
                    return Ok(value.clone());
                }
            }
            Ok(native)
        }
        "watcher:identity" => {
            if _window.label() != "main" {
                return Err(error(
                    "window",
                    "Only the main window can update log identity",
                ));
            }
            state.log_identity(app, first)
        }
        "watcher:connect" => state
            .logs
            .configure(app, &state.settings()?, true)
            .map_err(|e| error("logs", e)),
        "watcher:next" => state
            .logs
            .read_live(
                app,
                first
                    .as_u64()
                    .ok_or_else(|| error("logs_epoch", "Expected log configuration revision"))?,
            )
            .map_err(|e| error("logs", e)),
        "watcher:historyBegin" => state.logs.begin_history().map_err(|e| error("logs", e)),
        "watcher:historyNext" => state
            .logs
            .read_history(
                first
                    .as_u64()
                    .ok_or_else(|| error("logs_job", "Expected historical job ID"))?,
                args.get(1).and_then(Value::as_str),
            )
            .map_err(|e| error("logs", e)),
        "watcher:historyCancel" => state
            .logs
            .cancel_history(
                first
                    .as_u64()
                    .ok_or_else(|| error("logs_job", "Expected historical job ID"))?,
            )
            .map_err(|e| error("logs", e)),
        "watcher:recent" => {
            let epoch = state.logs.status().map_err(|e| error("logs", e))?["epoch"]
                .as_u64()
                .unwrap_or(0);
            let overlay = state
                .overlay
                .lock()
                .map_err(|_| error("overlay_lock", "Overlay state unavailable"))?;
            Ok(if overlay.epoch == epoch {
                json!(overlay.events)
            } else {
                json!([])
            })
        }
        "watcher:relay" | "watcher:relayState" => {
            if first.to_string().len() > 16 * 1024 {
                return Err(error("relay", "Overlay payload too large"));
            }
            let native = state.logs.status().map_err(|e| error("logs", e))?;
            let epoch = native["epoch"].as_u64().unwrap_or(0);
            let sent = if channel == "watcher:relayState" {
                first["epoch"].as_u64()
            } else {
                args.get(1).and_then(Value::as_u64)
            };
            if sent != Some(epoch) {
                return Ok(Value::Null);
            }
            let mut overlay = state
                .overlay
                .lock()
                .map_err(|_| error("overlay_lock", "Overlay state unavailable"))?;
            if overlay.epoch != epoch {
                overlay.events.clear();
                overlay.state = None;
                overlay.epoch = epoch;
            }
            if channel == "watcher:relay" {
                overlay.events.push_front(first.clone());
                if overlay.events.len() > 50 {
                    overlay.events.pop_back();
                }
                app.emit_to("searchbar", "watcher-event", first)
                    .map_err(|e| error("event", e.to_string()))?;
            } else {
                overlay.state = Some(first.clone());
                app.emit_to("searchbar", "watcher-state", first)
                    .map_err(|e| error("event", e.to_string()))?;
            }
            Ok(Value::Null)
        }
        "watcher:pickFolder" => {
            let selected = app.dialog().file().blocking_pick_folder();
            match selected {
                None => Ok(Value::Null),
                Some(path) => {
                    let path = path
                        .into_path()
                        .map_err(|e| error("directory", e.to_string()))?;
                    let path = safe_directory(&path.to_string_lossy())?;
                    state.update_settings(app, &json!({"logsPath":path.to_string_lossy()}))?;
                    state
                        .logs
                        .configure(app, &state.settings()?, true)
                        .map_err(|e| error("logs", e))?;
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
                let settings = state.logs.status().map_err(|e| error("logs", e))?;
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
pub async fn read_pack_resource(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
    relative: String,
) -> Result<tauri::ipc::Response, NativeError> {
    if !["main", "searchbar"].contains(&window.label()) {
        return Err(error("window", "Unrecognized application window"));
    }
    use std::sync::atomic::{AtomicUsize, Ordering};
    static READS: AtomicUsize = AtomicUsize::new(0);
    struct ReadLease;
    impl Drop for ReadLease {
        fn drop(&mut self) {
            READS.fetch_sub(1, Ordering::AcqRel);
        }
    }
    READS
        .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
            (n < 2).then_some(n + 1)
        })
        .map_err(|_| error("resource_busy", "Content reads are busy; retry shortly"))?;
    let lease = ReadLease;
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let packs = state
            .packs
            .as_ref()
            .map_err(|e| error("packs", e.clone()))?;
        let bytes = packs
            .read_resource(&relative)
            .map_err(|e| error("packs", e))?
            .ok_or_else(|| {
                error(
                    "resource_missing",
                    "No installed pack contains this resource",
                )
            })?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| error("native_job", e.to_string()))?
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

#[tauri::command]
pub async fn read_archived_screenshot(
    state: tauri::State<'_, Arc<HostState>>,
    window: tauri::WebviewWindow,
    hash: String,
) -> Result<tauri::ipc::Response, NativeError> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    if window.label() != "main" {
        return Err(error(
            "screenshot_scope",
            "Only the main window can review inventory evidence",
        ));
    }
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(error("screenshot_hash", "Invalid archived screenshot hash"));
    }
    let dir = state.data_dir.join("screenshots");
    tauri::async_runtime::spawn_blocking(move || {
        let root = dir.canonicalize()?;
        let path = root.join(&hash).canonicalize()?;
        if !path.starts_with(&root) {
            return Err(error(
                "screenshot_scope",
                "Screenshot is outside the evidence archive",
            ));
        }
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err(error(
                "screenshot_size",
                "Archived screenshot exceeds 64 MiB",
            ));
        }
        if format!("{:x}", Sha256::digest(&bytes)) != hash {
            return Err(error(
                "screenshot_corrupt",
                "Archived screenshot failed its checksum",
            ));
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|e| error("screenshot_job", e.to_string()))?
}

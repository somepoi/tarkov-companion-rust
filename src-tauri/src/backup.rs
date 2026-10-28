//! Portable, checksummed directory bundles. Restore never overwrites a live DB.
use crate::desktop::{HostState, atomic_write};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

static JOB: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);
const MAX_JSON: u64 = 20 * 1024 * 1024;
const MAX_FILE: u64 = 1024 * 1024 * 1024;
const MAX_TOTAL: u64 = 8 * 1024 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    Create { renderer_state: Value },
    List,
    OpenFolder,
    Restore { name: String },
    Import,
    Activate { recovery: String },
    Revert,
    PendingRenderer,
    AcknowledgeRenderer,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileEntry {
    bytes: u64,
    sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    kind: String,
    version: u32,
    created_at: u64,
    app_version: String,
    files: BTreeMap<String, FileEntry>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn name(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        now(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
fn valid_name(value: &str, prefix: &str) -> bool {
    value
        .strip_prefix(prefix)
        .and_then(|v| v.strip_prefix('-'))
        .is_some_and(|v| {
            !v.is_empty() && v.len() <= 80 && v.bytes().all(|b| b.is_ascii_digit() || b == b'-')
        })
}
fn hash_name(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn valid_relative(value: &str) -> bool {
    matches!(
        value,
        "user.sqlite" | "settings.json" | "renderer-state.json"
    ) || value.strip_prefix("screenshots/").is_some_and(hash_name)
}
fn source_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if !valid_relative(relative) {
        return Err("Unsupported backup path".into());
    }
    let file = root.join(relative);
    if !fs::symlink_metadata(&file)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Backup entry must be a regular file".into());
    }
    let canonical = file.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("Backup entry escapes its directory".into());
    }
    Ok(canonical)
}
fn read_json(path: &Path, max: u64) -> Result<Value, String> {
    if fs::metadata(path).map_err(|e| e.to_string())?.len() > max {
        return Err("JSON file exceeds the supported size".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max {
        return Err("JSON file grew beyond its supported size".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    atomic_write(path, &bytes).map_err(|e| e.to_string())
}
fn digest_file(path: &Path, destination: Option<&Path>) -> Result<FileEntry, String> {
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let mut output = destination
        .map(|p| OpenOptions::new().create_new(true).write(true).open(p))
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let n = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > MAX_FILE {
            return Err("Backup entry exceeds 1 GiB".into());
        }
        digest.update(&buffer[..n]);
        if let Some(output) = &mut output {
            output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
    }
    if let Some(output) = &mut output {
        output.sync_all().map_err(|e| e.to_string())?;
    }
    Ok(FileEntry {
        bytes: total,
        sha256: format!("{:x}", digest.finalize()),
    })
}
fn verify(root: &Path) -> Result<Manifest, String> {
    let manifest: Manifest =
        serde_json::from_value(read_json(&root.join("manifest.json"), 4 * 1024 * 1024)?)
            .map_err(|e| e.to_string())?;
    if manifest.kind != "tarkov-companion-rust-backup"
        || manifest.version != 1
        || manifest.files.len() > 50000
    {
        return Err("Unsupported backup manifest".into());
    }
    for required in ["user.sqlite", "renderer-state.json", "settings.json"] {
        if !manifest.files.contains_key(required) {
            return Err(format!("Backup is missing {required}"));
        }
    }
    let mut total = 0;
    for (relative, expected) in &manifest.files {
        if expected.bytes > MAX_FILE || !hash_name(&expected.sha256) {
            return Err("Invalid backup checksum or size".into());
        }
        if matches!(relative.as_str(), "settings.json" | "renderer-state.json")
            && expected.bytes > MAX_JSON
        {
            return Err("Backup JSON entry exceeds 20 MiB".into());
        }
        total += expected.bytes;
        if total > MAX_TOTAL {
            return Err("Backup exceeds 8 GiB".into());
        }
        if relative.starts_with("screenshots/")
            && (expected.bytes > 64 * 1024 * 1024 || relative[12..] != expected.sha256)
        {
            return Err("Invalid screenshot evidence entry".into());
        }
        let file = source_file(root, relative)?;
        if fs::metadata(&file).map_err(|e| e.to_string())?.len() != expected.bytes {
            return Err(format!("Backup size mismatch: {relative}"));
        }
        let actual = digest_file(&file, None)?;
        if actual.sha256 != expected.sha256 {
            return Err(format!("Backup checksum mismatch: {relative}"));
        }
    }
    validate_renderer(&read_json(
        &source_file(root, "renderer-state.json")?,
        MAX_JSON,
    )?)?;
    let settings = read_json(&source_file(root, "settings.json")?, MAX_JSON)?;
    if !settings.is_object() {
        return Err("Backup settings must be an object".into());
    }
    for hash in stash_core::Repository::verify_file(source_file(root, "user.sqlite")?)
        .map_err(|e| e.to_string())?
    {
        if !manifest.files.contains_key(&format!("screenshots/{hash}")) {
            return Err("Backup is missing referenced screenshot evidence".into());
        }
    }
    Ok(manifest)
}
fn validate_renderer(value: &Value) -> Result<(), String> {
    if value["kind"] != "tarkov-companion-rust-renderer-state"
        || value["version"] != 1
        || !value["localStorage"].is_object()
        || !value["corrections"].is_object()
    {
        return Err("Unsupported renderer backup state".into());
    }
    if serde_json::to_vec(value).map_err(|e| e.to_string())?.len() as u64 > MAX_JSON {
        return Err("Renderer state exceeds 20 MiB".into());
    }
    Ok(())
}
fn backup_root(state: &HostState) -> PathBuf {
    state.profile_root.join("full-backups")
}

pub fn active_profile(root: &Path) -> Result<PathBuf, String> {
    let pointer = root.join("active-profile.json");
    if !pointer.exists() {
        return Ok(root.to_owned());
    }
    let value = read_json(&pointer, 4096)?;
    let selected = value["recovery"]
        .as_str()
        .filter(|v| valid_name(v, "recovery"))
        .ok_or("Invalid active profile pointer; original profile remains in its root directory")?;
    let path = root
        .join("recovered-profiles")
        .join(selected)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(root) {
        return Err("Active profile escapes the profile root".into());
    }
    if !path.join("recovery-ready.json").is_file() {
        return Err("Recovered profile has not been fully prepared".into());
    }
    Ok(path)
}
fn create(state: &HostState, renderer: Value) -> Result<Value, String> {
    validate_renderer(&renderer)?;
    let root = backup_root(state);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let id = name("backup");
    let staging = root.join(format!(".incomplete-{id}"));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    state
        .inventory
        .as_ref()
        .map_err(Clone::clone)?
        .backup_to(staging.join("user.sqlite"))?;
    write_json(&staging.join("renderer-state.json"), &renderer)?;
    write_json(
        &staging.join("settings.json"),
        &state.settings().map_err(|e| e.to_string())?,
    )?;
    let mut files = BTreeMap::new();
    for file in ["user.sqlite", "renderer-state.json", "settings.json"] {
        files.insert(file.to_owned(), digest_file(&staging.join(file), None)?);
    }
    let source = state.data_dir.join("screenshots");
    fs::create_dir(staging.join("screenshots")).map_err(|e| e.to_string())?;
    let mut total: u64 = files.values().map(|f| f.bytes).sum();
    if source.exists() {
        for entry in fs::read_dir(&source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let file = entry.file_name().to_string_lossy().into_owned();
            if !hash_name(&file) {
                continue;
            } // Ignore an uncommitted archive temp file.
            let relative = format!("screenshots/{file}");
            let input = source_file(&state.data_dir, &relative)?;
            if fs::metadata(&input).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 {
                return Err("Screenshot exceeds 64 MiB".into());
            }
            let record = digest_file(&input, Some(&staging.join(&relative)))?;
            if record.sha256 != file {
                return Err("Archived screenshot checksum is invalid".into());
            }
            total += record.bytes;
            if total > MAX_TOTAL || files.len() >= 50000 {
                return Err("Backup exceeds supported size".into());
            }
            files.insert(relative, record);
        }
    }
    write_json(
        &staging.join("manifest.json"),
        &Manifest {
            kind: "tarkov-companion-rust-backup".into(),
            version: 1,
            created_at: now(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            files,
        },
    )?;
    verify(&staging)?;
    let destination = root.join(&id);
    fs::rename(staging, &destination).map_err(|e| e.to_string())?;
    Ok(json!({"name": id, "path": destination, "bytes": total}))
}
fn restore(state: &HostState, source: &Path) -> Result<Value, String> {
    let manifest = verify(source)?;
    let parent = state.profile_root.join("recovered-profiles");
    fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
    let id = name("recovery");
    let staging = parent.join(format!(".incomplete-{id}"));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    fs::create_dir(staging.join("screenshots")).map_err(|e| e.to_string())?;
    for (relative, expected) in &manifest.files {
        let actual = digest_file(
            &source_file(source, relative)?,
            Some(&staging.join(relative)),
        )?;
        if actual.sha256 != expected.sha256 || actual.bytes != expected.bytes {
            return Err("Backup changed while being restored; original profile retained".into());
        }
    }
    // A newer schema is rejected before any activation. Older schemas migrate
    // only in this isolated copy, never in the imported backup directory.
    let mut repository =
        stash_core::Repository::open(staging.join("user.sqlite")).map_err(|e| e.to_string())?;
    for profile in repository.list_profiles().map_err(|e| e.to_string())? {
        repository
            .inventory(&profile.id)
            .map_err(|e| e.to_string())?;
    }
    drop(repository);
    let settings_file = staging.join("settings.json");
    if settings_file.exists() {
        let mut settings = read_json(&settings_file, MAX_JSON)?;
        if !settings.is_object() {
            return Err("Recovered settings must contain an object".into());
        }
        settings["clearPositionShots"] = json!(false);
        fs::write(
            &settings_file,
            serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
    }
    write_json(
        &staging.join("recovery-ready.json"),
        &json!({"version":1,"preparedAt":now()}),
    )?;
    let destination = parent.join(&id);
    fs::rename(staging, &destination).map_err(|e| e.to_string())?;
    Ok(json!({"recovery":id,"path":destination}))
}

#[tauri::command]
pub async fn native_backup(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<HostState>>,
    operation: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Backup requires the main window".into());
    }
    if operation.to_string().len() as u64 > MAX_JSON {
        return Err("Backup request exceeds 20 MiB".into());
    }
    let operation: Operation = serde_json::from_value(operation).map_err(|e| e.to_string())?;
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = JOB.try_lock().map_err(|_| "A backup/recovery operation is already running")?;
        match operation {
            Operation::Create { renderer_state } => create(&state, renderer_state),
            Operation::List => {
                let root = backup_root(&state);
                let mut list = Vec::new();
                if root.exists() { for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !valid_name(&name, "backup") || !entry.file_type().map_err(|e| e.to_string())?.is_dir() { continue; }
                    let path = entry.path();
                    let value = read_json(&path.join("manifest.json"), 4 * 1024 * 1024)?;
                    list.push(json!({"name":name,"createdAt":value["createdAt"],"path":path}));
                } }
                list.sort_by_key(|v| std::cmp::Reverse(v["createdAt"].as_u64().unwrap_or(0)));
                Ok(json!({"backups":list,"activeProfile":state.data_dir,"originalProfile":state.profile_root,"startupIssues":state.startup_issues,"canRevert":state.profile_root.join("active-profile.json").exists()}))
            }
            Operation::OpenFolder => { let root = backup_root(&state); fs::create_dir_all(&root).map_err(|e| e.to_string())?; app.opener().open_path(root.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())?; Ok(Value::Null) }
            Operation::Restore { name } => { if !valid_name(&name, "backup") { return Err("Invalid backup name".into()); } restore(&state, &backup_root(&state).join(name)) }
            Operation::Import => match app.dialog().file().set_title("Select a Tarkov Companion Rust backup directory").blocking_pick_folder() {
                None => Ok(Value::Null), Some(path) => restore(&state, &path.into_path().map_err(|e| e.to_string())?),
            },
            Operation::Activate { recovery } => {
                if !valid_name(&recovery, "recovery") { return Err("Invalid recovery name".into()); }
                let target = state.profile_root.join("recovered-profiles").join(&recovery).canonicalize().map_err(|e| e.to_string())?;
                if !target.starts_with(&state.profile_root) || !target.join("recovery-ready.json").is_file() { return Err("Recovery is not ready or is outside the profile root".into()); }
                for hash in stash_core::Repository::verify_file(target.join("user.sqlite")).map_err(|e| e.to_string())? {
                    let file = source_file(&target, &format!("screenshots/{hash}"))?;
                    if fs::metadata(&file).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 || digest_file(&file, None)?.sha256 != hash { return Err("Recovered screenshot evidence is invalid".into()); }
                }
                validate_renderer(&read_json(&target.join("renderer-state.json"), MAX_JSON)?)?;
                write_json(&state.profile_root.join("active-profile.json"), &json!({"recovery":recovery}))?;
                app.request_restart(); Ok(Value::Null)
            }
            Operation::Revert => {
                let pointer = state.profile_root.join("active-profile.json");
                if pointer.exists() { fs::rename(&pointer, state.profile_root.join(name("inactive-profile-pointer"))).map_err(|e| e.to_string())?; }
                app.request_restart(); Ok(Value::Null)
            }
            Operation::PendingRenderer => {
                let file = state.data_dir.join("renderer-state.json");
                if file.exists() && !state.data_dir.join("renderer-imported.json").exists() { let value = read_json(&file, MAX_JSON)?; validate_renderer(&value)?; Ok(value) } else { Ok(Value::Null) }
            }
            Operation::AcknowledgeRenderer => { write_json(&state.data_dir.join("renderer-imported.json"), &json!({"at":now()}))?; Ok(Value::Null) }
        }
    }).await.map_err(|e| e.to_string())?
}

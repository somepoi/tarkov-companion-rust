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
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

static JOB: Mutex<()> = Mutex::new(());
static NEXT: AtomicU64 = AtomicU64::new(0);
const MAX_JSON: u64 = 20 * 1024 * 1024;
const MAX_FILE: u64 = 1024 * 1024 * 1024;
const MAX_TOTAL: u64 = 8 * 1024 * 1024 * 1024;

// One reporter per serialized job; updates are scoped to the requesting window.
struct Progress {
    window: tauri::WebviewWindow,
    last: std::time::Instant,
}
impl Progress {
    fn send(&mut self, stage: &str, bytes: u64, total: Option<u64>, force: bool) {
        if !force && self.last.elapsed() < std::time::Duration::from_millis(150) {
            return;
        }
        self.last = std::time::Instant::now();
        let _ = self.window.emit(
            "backup-progress",
            json!({"stage":stage,"bytes":bytes,"total":total}),
        );
    }
    fn stage(&mut self, stage: &str) {
        self.send(stage, 0, None, true);
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    Create { renderer_state: Value },
    Export { renderer_state: Value },
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
fn read_settings(root: &Path) -> Result<Value, String> {
    let settings = read_json(&source_file(root, "settings.json")?, MAX_JSON)?;
    if !settings.is_object() {
        return Err("Backup settings must contain a JSON object".into());
    }
    Ok(settings)
}
fn digest_file(
    path: &Path,
    destination: Option<&Path>,
    limit: u64,
    progress: &mut Progress,
) -> Result<FileEntry, String> {
    let stage = if destination.is_some() {
        "Copying file"
    } else {
        "Verifying file"
    };
    let limit = limit.min(MAX_FILE);
    let mut input = File::open(path).map_err(|e| e.to_string())?;
    let file_bytes = input
        .metadata()
        .map_err(|e| e.to_string())?
        .len()
        .min(limit);
    progress.send(stage, 0, Some(file_bytes), false);
    let mut output = destination
        .map(|p| OpenOptions::new().create_new(true).write(true).open(p))
        .transpose()
        .map_err(|e| e.to_string())?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        // Read at most one byte beyond the remaining budget to distinguish EOF
        // from growth. Never hash or copy bytes beyond the caller's limit.
        let capacity = ((limit - total + 1).min(buffer.len() as u64)) as usize;
        let n = input
            .read(&mut buffer[..capacity])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if n as u64 > limit - total {
            return Err(format!("Backup entry exceeds its {limit}-byte budget"));
        }
        total += n as u64;
        progress.send(stage, total, Some(file_bytes.max(total)), false);
        digest.update(&buffer[..n]);
        if let Some(output) = &mut output {
            output.write_all(&buffer[..n]).map_err(|e| e.to_string())?;
        }
    }
    if let Some(output) = &mut output {
        output.sync_all().map_err(|e| e.to_string())?;
    }
    progress.send(stage, total, Some(total), false);
    Ok(FileEntry {
        bytes: total,
        sha256: format!("{:x}", digest.finalize()),
    })
}
fn read_manifest(root: &Path) -> Result<Manifest, String> {
    if !fs::symlink_metadata(root.join("manifest.json"))
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Manifest must be a regular file".into());
    }
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
    Ok(manifest)
}

fn verify(root: &Path, progress: &mut Progress) -> Result<Manifest, String> {
    let manifest = read_manifest(root)?;
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
        let actual = digest_file(&file, None, expected.bytes, progress)?;
        if actual.bytes != expected.bytes || actual.sha256 != expected.sha256 {
            return Err(format!("Backup checksum mismatch: {relative}"));
        }
    }
    validate_renderer(&read_json(
        &source_file(root, "renderer-state.json")?,
        MAX_JSON,
    )?)?;
    read_settings(root)?;
    progress.stage("Verifying database and saved references");
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

fn recovery_parent(root: &Path) -> Result<PathBuf, String> {
    let parent = root.join("recovered-profiles");
    if parent.canonicalize().map_err(|e| e.to_string())? != parent || !parent.is_dir() {
        return Err("Recovered profiles directory is redirected".into());
    }
    Ok(parent)
}

fn recovery_directory(root: &Path, recovery: &str) -> Result<PathBuf, String> {
    if !valid_name(recovery, "recovery") {
        return Err("Invalid recovery name".into());
    }
    let directory = recovery_parent(root)?.join(recovery);
    if directory.canonicalize().map_err(|e| e.to_string())? != directory || !directory.is_dir() {
        return Err("Recovered profile directory is redirected".into());
    }
    let ready = directory.join("recovery-ready.json");
    if !fs::symlink_metadata(&ready)
        .map_err(|e| e.to_string())?
        .is_file()
        || read_json(&ready, 4096)?["version"] != 1
    {
        return Err("Recovered profile has not been fully prepared".into());
    }
    // Do not silently create an empty database or settings file for a partial recovery.
    for name in ["user.sqlite", "settings.json", "renderer-state.json"] {
        source_file(&directory, name).map_err(|e| format!("Recovered profile {name}: {e}"))?;
    }
    Ok(directory)
}

pub fn active_profile(root: &Path) -> Result<PathBuf, String> {
    let pointer = root.join("active-profile.json");
    match fs::symlink_metadata(&pointer) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(root.to_owned()),
        Err(e) => return Err(e.to_string()),
        Ok(metadata) if !metadata.is_file() => return Err("Invalid active profile pointer".into()),
        Ok(_) => {}
    }
    let value = read_json(&pointer, 4096)?;
    let selected = value["recovery"]
        .as_str()
        .filter(|v| valid_name(v, "recovery"))
        .ok_or("Invalid active profile pointer; original profile remains in its root directory")?;
    recovery_directory(root, selected)
}
fn create(
    state: &HostState,
    renderer: Value,
    root: &Path,
    progress: &mut Progress,
) -> Result<Value, String> {
    progress.stage("Creating database snapshot");
    validate_renderer(&renderer)?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
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
        let limit = if file == "user.sqlite" {
            MAX_FILE
        } else {
            MAX_JSON
        };
        files.insert(
            file.to_owned(),
            digest_file(&staging.join(file), None, limit, progress)?,
        );
    }
    // Bind archive membership to the immutable SQLite snapshot, not the live
    // directory (which can contain later captures or abandoned archive files).
    progress.stage("Reading saved screenshot references");
    let evidence = stash_core::Repository::verify_file(staging.join("user.sqlite"))
        .map_err(|e| e.to_string())?;
    fs::create_dir(staging.join("screenshots")).map_err(|e| e.to_string())?;
    let mut total: u64 = files.values().map(|f| f.bytes).sum();
    if total > MAX_TOTAL || evidence.len() > 50000 - files.len() {
        return Err("Backup exceeds supported size".into());
    }
    for file in evidence {
        let relative = format!("screenshots/{file}");
        let input = source_file(&state.data_dir, &relative)?;
        let bytes = fs::metadata(&input).map_err(|e| e.to_string())?.len();
        if bytes > 64 * 1024 * 1024 {
            return Err("Screenshot exceeds 64 MiB".into());
        }
        if bytes > MAX_TOTAL - total {
            return Err("Backup exceeds supported size".into());
        }
        let record = digest_file(&input, Some(&staging.join(&relative)), bytes, progress)?;
        if record.sha256 != file {
            return Err("Archived screenshot checksum is invalid".into());
        }
        total += record.bytes;
        if total > MAX_TOTAL || files.len() >= 50000 {
            return Err("Backup exceeds supported size".into());
        }
        files.insert(relative, record);
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
    verify(&staging, progress)?;
    let destination = root.join(&id);
    fs::rename(staging, &destination).map_err(|e| e.to_string())?;
    Ok(json!({"name": id, "path": destination, "bytes": total}))
}
fn restore(state: &HostState, source: &Path, progress: &mut Progress) -> Result<Value, String> {
    let manifest = verify(source, progress)?;
    match fs::create_dir(state.profile_root.join("recovered-profiles")) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.to_string()),
    }
    let parent = recovery_parent(&state.profile_root)?;
    let id = name("recovery");
    let staging = parent.join(format!(".incomplete-{id}"));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    fs::create_dir(staging.join("screenshots")).map_err(|e| e.to_string())?;
    for (relative, expected) in &manifest.files {
        let actual = digest_file(
            &source_file(source, relative)?,
            Some(&staging.join(relative)),
            expected.bytes,
            progress,
        )?;
        if actual.sha256 != expected.sha256 || actual.bytes != expected.bytes {
            return Err("Backup changed while being restored; original profile retained".into());
        }
    }
    // A newer schema is rejected before any activation. Older schemas migrate
    // only in this isolated copy, never in the imported backup directory.
    progress.stage("Preparing recovered database");
    let mut repository =
        stash_core::Repository::open(staging.join("user.sqlite")).map_err(|e| e.to_string())?;
    for profile in repository.list_profiles().map_err(|e| e.to_string())? {
        repository
            .inventory(&profile.id)
            .map_err(|e| e.to_string())?;
    }
    drop(repository);
    let mut settings = read_settings(&staging)?;
    settings["clearPositionShots"] = json!(false);
    let settings_bytes = serde_json::to_vec(&settings).map_err(|e| e.to_string())?;
    if settings_bytes.len() as u64 > MAX_JSON {
        return Err("Recovered settings exceed 20 MiB".into());
    }
    atomic_write(&staging.join("settings.json"), &settings_bytes).map_err(|e| e.to_string())?;
    write_json(
        &staging.join("recovery-ready.json"),
        &json!({"version":1,"preparedAt":now()}),
    )?;
    let destination = parent.join(&id);
    if staging.canonicalize().map_err(|e| e.to_string())? != staging || destination.exists() {
        return Err("Recovered profile destination changed during preparation".into());
    }
    fs::rename(staging, &destination).map_err(|e| e.to_string())?;
    Ok(json!({"recovery":id,"path":destination}))
}

/// Discovery validates manifest structure only. Restore verifies every byte and
/// database reference again; a listed bundle is never implicitly trusted.
fn list(state: &HostState) -> Result<Value, String> {
    let root = backup_root(state);
    let mut backups = Vec::new();
    let mut issues = Vec::new();
    let mut skipped = 0_usize;
    match fs::read_dir(&root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
        Ok(entries) => {
            for (index, entry) in entries.enumerate() {
                if index >= 10_000 {
                    issues.push("Backup listing stopped at 10,000 directory entries. Use Restore from a folder to select an omitted backup.".to_owned());
                    break;
                }
                let result = (|| -> Result<Option<Value>, String> {
                    let entry = entry.map_err(|e| e.to_string())?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !valid_name(&name, "backup") {
                        return Ok(None);
                    }
                    let candidate = (|| -> Result<Value, String> {
                        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                            return Err("Backup must be a regular directory".into());
                        }
                        let path = entry.path();
                        let manifest = read_manifest(&path)?;
                        Ok(json!({"name":name,"createdAt":manifest.created_at,"path":path}))
                    })();
                    candidate.map(Some).map_err(|e| format!("{name}: {e}"))
                })();
                match result {
                    Ok(Some(backup)) => backups.push(backup),
                    Ok(None) => {}
                    Err(e) => {
                        skipped += 1;
                        if issues.len() < 100 {
                            issues.push(e);
                        }
                    }
                }
            }
        }
    }
    if skipped > 100 {
        issues.push(format!(
            "{skipped} unreadable entries were skipped; only the first 100 errors are shown."
        ));
    }
    backups.sort_by_key(|v| std::cmp::Reverse(v["createdAt"].as_u64().unwrap_or(0)));
    Ok(
        json!({"backups":backups,"issues":issues,"activeProfile":state.data_dir,"originalProfile":state.profile_root,"startupIssues":state.startup_issues,"canRevert":fs::symlink_metadata(state.profile_root.join("active-profile.json")).is_ok()}),
    )
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
    let lease = crate::jobs::enter().map_err(str::to_owned)?;
    let operation: Operation = serde_json::from_value(operation).map_err(|e| e.to_string())?;
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let _guard = JOB
            .try_lock()
            .map_err(|_| "A backup/recovery operation is already running")?;
        let mut progress = Progress {
            window,
            last: std::time::Instant::now(),
        };
        progress.stage("Preparing backup operation");
        match operation {
            Operation::Create { renderer_state } => {
                create(&state, renderer_state, &backup_root(&state), &mut progress)
            }
            Operation::Export { renderer_state } => {
                validate_renderer(&renderer_state)?;
                progress.stage("Choose an export folder");
                match app
                    .dialog()
                    .file()
                    .set_title("Choose a folder for the full backup")
                    .blocking_pick_folder()
                {
                    None => Ok(Value::Null),
                    Some(path) => {
                        let root = path
                            .into_path()
                            .map_err(|e| e.to_string())?
                            .canonicalize()
                            .map_err(|e| e.to_string())?;
                        if !root.is_dir() {
                            return Err("Export destination must be an existing directory".into());
                        }
                        create(&state, renderer_state, &root, &mut progress)
                    }
                }
            }
            Operation::List => list(&state),
            Operation::OpenFolder => {
                let root = backup_root(&state);
                fs::create_dir_all(&root).map_err(|e| e.to_string())?;
                app.opener()
                    .open_path(root.to_string_lossy(), None::<&str>)
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            Operation::Restore { name } => {
                if !valid_name(&name, "backup") {
                    return Err("Invalid backup name".into());
                }
                restore(&state, &backup_root(&state).join(name), &mut progress)
            }
            Operation::Import => match app
                .dialog()
                .file()
                .set_title("Select a Tarkov Companion Rust backup directory")
                .blocking_pick_folder()
            {
                None => Ok(Value::Null),
                Some(path) => restore(
                    &state,
                    &path.into_path().map_err(|e| e.to_string())?,
                    &mut progress,
                ),
            },
            Operation::Activate { recovery } => {
                let target = recovery_directory(&state.profile_root, &recovery)?;
                read_settings(&target)?;
                validate_renderer(&read_json(
                    &source_file(&target, "renderer-state.json")?,
                    MAX_JSON,
                )?)?;
                progress.stage("Verifying database and saved references");
                for hash in
                    stash_core::Repository::verify_file(source_file(&target, "user.sqlite")?)
                        .map_err(|e| e.to_string())?
                {
                    let file = source_file(&target, &format!("screenshots/{hash}"))?;
                    if fs::metadata(&file).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024
                        || digest_file(&file, None, 64 * 1024 * 1024, &mut progress)?.sha256 != hash
                    {
                        return Err("Recovered screenshot evidence is invalid".into());
                    }
                }
                write_json(
                    &state.profile_root.join("active-profile.json"),
                    &json!({"recovery":recovery}),
                )?;
                app.request_restart();
                Ok(Value::Null)
            }
            Operation::Revert => {
                let pointer = state.profile_root.join("active-profile.json");
                match fs::symlink_metadata(&pointer) {
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        return Err("No recovered profile is selected".into());
                    }
                    Err(e) => return Err(e.to_string()),
                    Ok(_) => {}
                }
                fs::rename(
                    &pointer,
                    state.profile_root.join(name("inactive-profile-pointer")),
                )
                .map_err(|e| e.to_string())?;
                app.request_restart();
                Ok(Value::Null)
            }
            Operation::PendingRenderer => {
                if state.data_dir == state.profile_root {
                    return Ok(Value::Null);
                }
                let imported = state.data_dir.join("renderer-imported.json");
                match fs::symlink_metadata(&imported) {
                    Ok(metadata) if metadata.is_file() => {
                        if read_json(&imported, 4096)?["at"].as_u64().is_none() {
                            return Err("Invalid renderer recovery receipt".into());
                        }
                        return Ok(Value::Null);
                    }
                    Ok(_) => return Err("Invalid renderer recovery receipt".into()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
                let value = read_json(
                    &source_file(&state.data_dir, "renderer-state.json")?,
                    MAX_JSON,
                )?;
                validate_renderer(&value)?;
                Ok(value)
            }
            Operation::AcknowledgeRenderer => {
                if state.data_dir == state.profile_root {
                    return Err("No recovered renderer state to acknowledge".into());
                }
                write_json(
                    &state.data_dir.join("renderer-imported.json"),
                    &json!({"at":now()}),
                )?;
                Ok(Value::Null)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Privileged caller holds the exclusive IO gate; do not acquire a shared lease.
#[cfg(feature = "staged-updates")]
pub(crate) fn recovery_copy(
    state: &HostState,
    renderer: Value,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    let _job = JOB.try_lock().map_err(|_| "A backup is already running")?;
    let mut progress = Progress {
        window,
        last: std::time::Instant::now(),
    };
    create(state, renderer, &backup_root(state), &mut progress)
}

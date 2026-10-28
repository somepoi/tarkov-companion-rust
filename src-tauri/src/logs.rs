//! Event-driven, read-only log transport. The renderer pulls one bounded chunk
//! at a time and acknowledges parsing before requesting another.
use encoding_rs::{Decoder, UTF_8};
use notify::{RecursiveMode, Watcher};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeSet, VecDeque},
    fs::{self, File, Metadata},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::Emitter;

const CHUNK: usize = 256 * 1024;
const MAX_FILES: usize = 50_000;
const REPLACED: &str = "Log was truncated or replaced";
#[derive(Default)]
pub struct Logs {
    state: Mutex<State>,
    dirty: Arc<AtomicBool>,
    watch_error: Arc<Mutex<Option<(u64, String)>>>,
    watch_epoch: Arc<AtomicU64>,
}
#[derive(Default)]
struct State {
    configured_path: Option<String>,
    detected_path: Option<String>,
    path: Option<String>,
    root: Option<PathBuf>,
    paused: bool,
    epoch: u64,
    sequence: u64,
    live: Cursor,
    history: Option<History>,
    watcher: Option<notify::RecommendedWatcher>,
    error: Option<String>,
    root_creation: Option<u64>,
    watch_paths: Vec<(PathBuf, bool)>,
    watch_failed: bool,
    watch_errors: VecDeque<Instant>,
    watch_warning: Option<String>,
}
#[derive(Default)]
struct Cursor {
    root: Option<PathBuf>,
    folder: Option<String>,
    session: u64,
    files: Vec<Tail>,
    index: usize,
}
struct History {
    id: u64,
    folders: Vec<PathBuf>,
    index: usize,
    cursor: Cursor,
    files: usize,
    key: Option<String>,
}
struct Tail {
    path: PathBuf,
    name: String,
    offset: u64,
    baseline: u64,
    creation: u64,
    decoder: Decoder,
    prefix: Vec<u8>,
    boundary: Vec<u8>,
}

fn folder_key(name: &str) -> Option<[u32; 6]> {
    let mut pieces = name.strip_prefix("log_")?.split('_');
    let date = pieces.next()?;
    let time = pieces.next()?;
    let values = date
        .split('.')
        .chain(time.split('-'))
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    let key: [u32; 6] = values.try_into().ok()?;
    (key[0] >= 2000
        && (1..=12).contains(&key[1])
        && (1..=31).contains(&key[2])
        && key[3] < 24
        && key[4] < 60
        && key[5] < 60)
        .then_some(key)
}
fn role(name: &str) -> Option<&'static str> {
    let name = name.to_ascii_lowercase();
    let stem = name.strip_suffix(".log")?;
    let stem = match stem.rsplit_once('_') {
        Some((base, number))
            if !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()) =>
        {
            base
        }
        _ => stem,
    };
    match stem.rsplit([' ', '_']).next()? {
        "application" => Some("application"),
        "notifications" | "push-notifications" => Some("notifications"),
        _ => None,
    }
}
fn path_prefix(path: &Path, base: &Path) -> bool {
    let mut parts = path.components();
    base.components().all(|expected| {
        parts.next().is_some_and(|actual| {
            if cfg!(windows) {
                actual.as_os_str().to_string_lossy().to_lowercase()
                    == expected.as_os_str().to_string_lossy().to_lowercase()
            } else {
                actual == expected
            }
        })
    })
}
fn watch_failure(state: &mut State, cause: String) -> bool {
    state.watcher = None;
    state.watch_paths.clear();
    state
        .watch_errors
        .retain(|at| at.elapsed() < Duration::from_secs(60));
    state.watch_errors.push_back(Instant::now());
    if state.watch_errors.len() >= 3 {
        state.watch_failed = true;
        state.error = Some(format!(
            "{cause}. Watching stopped after repeated errors; reconnect the log folder."
        ));
        return false;
    }
    state.watch_warning = Some(format!("Log watching was rearmed after an error: {cause}"));
    state.epoch += 1;
    state.live = Cursor::default();
    state.history = None;
    true
}
fn scoped(path: &Path, root: &Path) -> Result<PathBuf, String> {
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) {
        return Err("Log path is outside the selected directory".into());
    }
    Ok(resolved)
}
fn folders(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut found = Vec::new();
    for (index, entry) in fs::read_dir(root).map_err(|e| e.to_string())?.enumerate() {
        if index >= MAX_FILES {
            return Err("Log directory exceeds 50000 entries; choose a smaller directory".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        if let Some(key) = folder_key(&entry.file_name().to_string_lossy()) {
            found.push((key, scoped(&entry.path(), root)?));
        }
        if found.len() > 10_000 {
            return Err(
                "More than 10000 log session folders; choose a smaller archived log directory"
                    .into(),
            );
        }
    }
    found.sort();
    Ok(found.into_iter().map(|(_, path)| path).collect())
}
#[cfg(windows)]
fn creation(metadata: &Metadata) -> u64 {
    use std::os::windows::fs::MetadataExt;
    metadata.creation_time()
}
#[cfg(not(windows))]
fn creation(metadata: &Metadata) -> u64 {
    metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos() as u64)
}

fn tails(folder: &Path, root: &Path, historical: bool) -> Result<Vec<Tail>, String> {
    let mut found = Vec::new();
    for (index, entry) in fs::read_dir(folder).map_err(|e| e.to_string())?.enumerate() {
        if index >= MAX_FILES {
            return Err("Log session exceeds 50000 directory entries".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if role(&name).is_none() || !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        let path = scoped(&entry.path(), root)?;
        let metadata = path.metadata().map_err(|e| e.to_string())?;
        found.push(Tail {
            path,
            name,
            offset: 0,
            baseline: if historical { metadata.len() } else { 0 },
            creation: creation(&metadata),
            decoder: UTF_8.new_decoder(),
            prefix: Vec::new(),
            boundary: Vec::new(),
        });
        if found.len() > MAX_FILES {
            return Err("Too many files in one log session".into());
        }
    }
    found.sort_by(|a, b| {
        (role(&a.name) != Some("application"), &a.name)
            .cmp(&(role(&b.name) != Some("application"), &b.name))
    });
    Ok(found)
}
fn session_key(root: &Path, folder: &Path) -> Result<String, String> {
    let mut hash = Sha256::new();
    hash.update(b"tc-log-history-v1");
    hash.update(env!("CARGO_PKG_VERSION").as_bytes());
    for path in [root, folder] {
        let metadata = path.metadata().map_err(|e| e.to_string())?;
        hash.update(path.to_string_lossy().as_bytes());
        hash.update(creation(&metadata).to_le_bytes());
    }
    for tail in tails(folder, root, true)? {
        let metadata = tail.path.metadata().map_err(|e| e.to_string())?;
        hash.update(
            serde_json::to_vec(&json!([tail.name, metadata.len(), creation(&metadata)]))
                .map_err(|e| e.to_string())?,
        );
        let modified = metadata
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        hash.update(modified.to_le_bytes());
    }
    Ok(format!("{:x}", hash.finalize()))
}
impl Cursor {
    fn reset(
        &mut self,
        folder: &Path,
        root: &Path,
        session: u64,
        historical: bool,
    ) -> Result<(), String> {
        self.root = Some(root.to_owned());
        self.folder = Some(
            folder
                .file_name()
                .ok_or("Missing session name")?
                .to_string_lossy()
                .into_owned(),
        );
        self.session = session;
        self.files = tails(folder, root, historical)?;
        self.index = 0;
        Ok(())
    }
    fn read(&mut self, history: bool) -> Result<Option<Value>, String> {
        while self.index < self.files.len() {
            let tail = &mut self.files[self.index];
            scoped(&tail.path, self.root.as_deref().ok_or("Missing log scope")?)?;
            let mut file = File::open(&tail.path)
                .map_err(|e| format!("Cannot read log {}: {e}", tail.name))?;
            let metadata = file.metadata().map_err(|e| e.to_string())?;
            let mut prefix = vec![
                0_u8;
                if tail.prefix.is_empty() {
                    metadata.len().min(128) as usize
                } else {
                    tail.prefix.len()
                }
            ];
            file.read_exact(&mut prefix).map_err(|_| REPLACED)?;
            if !tail.prefix.is_empty() && prefix != tail.prefix {
                return Err(REPLACED.into());
            }
            if tail.prefix.is_empty() {
                tail.prefix = prefix;
            }
            if !tail.boundary.is_empty() {
                file.seek(SeekFrom::Start(
                    tail.offset.saturating_sub(tail.boundary.len() as u64),
                ))
                .map_err(|e| e.to_string())?;
                let mut boundary = vec![0; tail.boundary.len()];
                file.read_exact(&mut boundary).map_err(|_| REPLACED)?;
                if boundary != tail.boundary {
                    return Err(REPLACED.into());
                }
            }
            if creation(&metadata) != tail.creation
                || metadata.len() < tail.offset
                || (history && metadata.len() < tail.baseline)
            {
                return Err(REPLACED.into());
            }
            let size = if history {
                tail.baseline.min(metadata.len())
            } else {
                metadata.len()
            };
            if tail.offset >= size {
                self.index += 1;
                continue;
            }
            let historical = history || tail.offset < tail.baseline;
            let boundary = if !history && historical {
                size.min(tail.baseline)
            } else {
                size
            };
            let mut bytes = vec![0_u8; (boundary - tail.offset).min(CHUNK as u64) as usize];
            file.seek(SeekFrom::Start(tail.offset))
                .map_err(|e| e.to_string())?;
            let n = file.read(&mut bytes).map_err(|e| e.to_string())?;
            if n == 0 {
                self.index += 1;
                continue;
            }
            tail.offset += n as u64;
            if n >= 128 {
                tail.boundary.clear();
                tail.boundary.extend_from_slice(&bytes[n - 128..n]);
            } else {
                tail.boundary.extend_from_slice(&bytes[..n]);
                if tail.boundary.len() > 128 {
                    tail.boundary.drain(..tail.boundary.len() - 128);
                }
            }
            let end = tail.offset >= size;
            let mut text = String::with_capacity(CHUNK * 3 + 16);
            let (_, consumed, invalid) =
                tail.decoder
                    .decode_to_string(&bytes[..n], &mut text, history && end);
            if consumed != n {
                return Err("Log decoder exceeded its bounded output buffer".into());
            }
            if end {
                self.index += 1;
            }
            return Ok(Some(
                json!({"session":self.session,"folder":self.folder,"file":format!("{}/{}",self.folder.as_deref().unwrap_or("unknown"),tail.name),"role":role(&tail.name),"text":text,"historical":historical,"flush":history && end,"invalidUtf8":invalid}),
            ));
        }
        Ok(None)
    }
}
impl Logs {
    pub fn configure(
        &self,
        app: &tauri::AppHandle,
        settings: &Value,
        reconnect: bool,
    ) -> Result<Value, String> {
        let path = if crate::desktop::benchmark_mode() {
            None
        } else {
            settings["logsPath"].as_str().map(str::to_owned)
        };
        let paused = crate::desktop::benchmark_mode() || settings["paused"] == true;
        let mut state = self.state.lock().map_err(|_| "Log state is unavailable")?;
        if !reconnect && state.configured_path == path && state.paused == paused {
            return Ok(status(&state));
        }
        state.epoch += 1;
        self.watch_epoch.store(state.epoch, Ordering::Release);
        state.configured_path = path.clone();
        state.detected_path = if path.is_none() && !crate::desktop::benchmark_mode() {
            crate::log_locator::detect()
        } else {
            None
        };
        state.path = path.or_else(|| state.detected_path.clone());
        state.paused = paused;
        state.live = Cursor::default();
        state.history = None;
        state.watcher = None;
        state.error = None;
        *self
            .watch_error
            .lock()
            .map_err(|_| "Log error state is unavailable")? = None;
        state.root = None;
        state.root_creation = None;
        state.watch_paths.clear();
        state.watch_failed = false;
        state.watch_errors.clear();
        state.watch_warning = None;
        self.reconcile_watch(app, &mut state)?;
        self.dirty.store(true, Ordering::Release);
        let value = status(&state);
        let _ = app.emit("native-logs-dirty", state.epoch);
        Ok(value)
    }
    fn reconcile_watch(&self, app: &tauri::AppHandle, state: &mut State) -> Result<(), String> {
        if state.path.is_none() || state.watch_failed {
            return Ok(());
        }
        let selected = PathBuf::from(state.path.as_ref().ok_or("No selected log root")?);
        let resolved = selected.canonicalize().ok().filter(|path| path.is_dir());
        let created = resolved
            .as_ref()
            .and_then(|path| path.metadata().ok())
            .map(|metadata| creation(&metadata));
        let changed = state.root != resolved || state.root_creation != created;
        if changed {
            state.epoch += 1;
            state.live = Cursor::default();
            state.history = None;
            state.root = resolved.clone();
            state.root_creation = created;
        }
        if state.paused {
            return Ok(());
        }
        let mut desired = Vec::new();
        let mut aliases = vec![selected.clone()];
        if let Some(root) = &resolved {
            desired.push((root.clone(), true));
        }
        let mut parent = selected.parent();
        for _ in 0..32 {
            let Some(path) = parent else { break };
            if let Ok(anchor) = path.canonicalize()
                && anchor.is_dir()
            {
                if let Ok(suffix) = selected.strip_prefix(path) {
                    aliases.push(anchor.join(suffix));
                }
                desired.push((anchor, false));
                break;
            }
            parent = path.parent();
        }
        if changed || state.watcher.is_none() || desired != state.watch_paths {
            state.watcher = None;
            state.watch_paths.clear();
            self.watch_epoch.store(state.epoch, Ordering::Release);
            let dirty = Arc::clone(&self.dirty);
            let error = Arc::clone(&self.watch_error);
            let watch_epoch = Arc::clone(&self.watch_epoch);
            let handle = app.clone();
            let epoch = state.epoch;
            let watch = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if watch_epoch.load(Ordering::Acquire) != epoch {
                    return;
                }
                match event {
                    Ok(event) => {
                        if matches!(event.kind, notify::EventKind::Access(_)) {
                            return;
                        }
                        if !event.paths.is_empty()
                            && !event.paths.iter().any(|path| {
                                aliases.iter().any(|target| {
                                    path_prefix(path, target) || path_prefix(target, path)
                                }) || resolved.as_ref().is_some_and(|root| {
                                    path_prefix(path, root) || path_prefix(root, path)
                                })
                            })
                        {
                            return;
                        }
                    }
                    Err(cause) => {
                        if let Ok(mut error) = error.lock() {
                            *error = Some((
                                epoch,
                                format!("Log watcher error: {cause}. Reconnect the log folder."),
                            ));
                        }
                    }
                }
                if !dirty.swap(true, Ordering::AcqRel) {
                    let _ = handle.emit("native-logs-dirty", epoch);
                }
            })
            .and_then(|mut watcher| {
                for (path, recursive) in &desired {
                    watcher.watch(
                        path,
                        if *recursive {
                            RecursiveMode::Recursive
                        } else {
                            RecursiveMode::NonRecursive
                        },
                    )?;
                }
                Ok(watcher)
            });
            match watch {
                Ok(watcher) if !desired.is_empty() => { state.watcher = Some(watcher); state.watch_paths = desired; }
                Ok(_) => state.error = Some("No existing ancestor is available to observe the log folder. Reconnect when it returns.".into()),
                Err(cause) => {
                    if watch_failure(state, cause.to_string()) { return self.reconcile_watch(app, state); }
                }
            }
        }
        if !state.watch_failed && state.watcher.is_some() {
            state.error = if state.root.is_some() {
                None
            } else {
                Some("Selected log directory is unavailable; waiting for its recreation".into())
            };
        }
        Ok(())
    }
    pub fn status(&self) -> Result<Value, String> {
        let state = self.state.lock().map_err(|_| "Log state is unavailable")?;
        Ok(status(&state))
    }
    pub fn read_live(&self, app: &tauri::AppHandle, epoch: u64) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|_| "Log state is unavailable")?;
        if state.epoch != epoch {
            return Err("Log configuration changed".into());
        }
        let refreshed = self.dirty.swap(false, Ordering::AcqRel);
        let watch_error = self
            .watch_error
            .lock()
            .map_err(|_| "Log error state is unavailable")?
            .take();
        if refreshed {
            self.reconcile_watch(app, &mut state)?;
        }
        if let Some((error_epoch, error)) = watch_error
            && error_epoch == state.epoch
            && watch_failure(&mut state, error)
        {
            self.reconcile_watch(app, &mut state)?;
        }
        if state.paused || state.root.is_none() || state.error.is_some() {
            return Ok(json!({"state":status(&state),"chunk":null}));
        }
        let root = state.root.clone().ok_or("No log folder")?;
        if refreshed || state.live.folder.is_none() {
            let found = folders(&root)?;
            if let Some(latest) = found.last() {
                let name = latest
                    .file_name()
                    .ok_or("Missing session name")?
                    .to_string_lossy();
                if state.live.folder.as_deref() != Some(name.as_ref()) {
                    let historical = state.live.folder.is_none();
                    state.sequence += 1;
                    let session = state.sequence;
                    state.live.reset(latest, &root, session, historical)?;
                } else {
                    if state.live.files.iter().any(|tail| !tail.path.is_file()) {
                        state.sequence += 1;
                        let sequence = state.sequence;
                        state.live.reset(latest, &root, sequence, true)?;
                    }
                    let known = state
                        .live
                        .files
                        .iter()
                        .map(|t| t.name.clone())
                        .collect::<BTreeSet<_>>();
                    let new = tails(latest, &root, false)?
                        .into_iter()
                        .filter(|t| !known.contains(&t.name));
                    state.live.files.extend(new);
                    state
                        .live
                        .files
                        .sort_by_key(|t| (role(&t.name) != Some("application"), t.name.clone()));
                    state.live.index = 0;
                }
            } else if state.live.folder.is_some() {
                state.live = Cursor::default();
                state.epoch += 1;
                state.watcher = None;
                self.reconcile_watch(app, &mut state)?;
            }
        }
        let mut result = state.live.read(false);
        if result.as_ref().is_err_and(|error| error == REPLACED)
            && let Some(folder) = state.live.folder.clone()
        {
            state.sequence += 1;
            let sequence = state.sequence;
            result = state
                .live
                .reset(&root.join(folder), &root, sequence, true)
                .and_then(|()| state.live.read(false));
        }
        match result {
            Ok(chunk) => Ok(json!({"state":status(&state),"chunk":chunk})),
            Err(error) => {
                state.error = Some(error);
                Ok(json!({"state":status(&state),"chunk":null}))
            }
        }
    }
    pub fn begin_history(&self) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|_| "Log state is unavailable")?;
        if state.history.is_some() {
            return Err("Historical log reading is already running".into());
        }
        let root = state.root.as_ref().ok_or("Choose a log directory first")?;
        let found = folders(root)?;
        state.sequence += 1;
        let id = state.sequence;
        let count = found.len();
        state.history = Some(History {
            id,
            folders: found,
            index: 0,
            cursor: Cursor::default(),
            files: 0,
            key: None,
        });
        Ok(json!({"id":id,"folders":count}))
    }
    pub fn read_history(&self, id: u64, skip: Option<&str>) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|_| "Log state is unavailable")?;
        let root = state.root.clone().ok_or("No log directory")?;
        let history = state
            .history
            .as_mut()
            .filter(|h| h.id == id)
            .ok_or("Historical read was replaced or cancelled")?;
        if let Some(skip) = skip {
            let key = history
                .key
                .as_deref()
                .ok_or("No historical session is awaiting cache admission")?;
            if skip != key
                || history.index + 1 >= history.folders.len()
                || history.cursor.files.iter().any(|tail| tail.offset != 0)
                || session_key(&root, &history.folders[history.index])? != key
            {
                return Err("Cached log session changed; read history again".into());
            }
            history.index += 1;
            history.cursor = Cursor::default();
            history.key = None;
            return Ok(json!({"done":false,"sessionSkipped":true}));
        }
        {
            if history.index >= history.folders.len() {
                let files = history.files;
                let folders = history.folders.len();
                state.history = None;
                return Ok(json!({"done":true,"files":files,"folders":folders}));
            }
            if history.cursor.folder.is_none() {
                let key = session_key(&root, &history.folders[history.index])?;
                history.cursor.reset(
                    &history.folders[history.index],
                    &root,
                    id + history.index as u64,
                    true,
                )?;
                history.files += history.cursor.files.len();
                if history.files > MAX_FILES {
                    return Err("Historical read exceeds 50000 files".into());
                }
                if history.index + 1 < history.folders.len()
                    && session_key(&root, &history.folders[history.index])? != key
                {
                    return Err(
                        "Historical session changed during admission; read history again".into(),
                    );
                }
                history.key = Some(key.clone());
                return Ok(
                    json!({"done":false,"sessionBegin":{"key":key,"session":history.cursor.session,"cacheable":history.index + 1 < history.folders.len()},"progress":{"done":history.index,"total":history.folders.len(),"folder":history.cursor.folder}}),
                );
            }
            if let Some(chunk) = history.cursor.read(true)? {
                return Ok(
                    json!({"done":false,"chunk":chunk,"progress":{"done":history.index,"total":history.folders.len(),"folder":history.cursor.folder}}),
                );
            }
            let key = history
                .key
                .take()
                .ok_or("Missing historical session signature")?;
            let cacheable = history.index + 1 < history.folders.len();
            if cacheable && session_key(&root, &history.folders[history.index])? != key {
                return Err(
                    "Historical log session changed during parsing; read history again".into(),
                );
            }
            history.index += 1;
            history.cursor = Cursor::default();
            Ok(json!({"done":false,"sessionEnd":{"key":key,"cacheable":cacheable}}))
        }
    }
    pub fn cancel_history(&self, id: u64) -> Result<Value, String> {
        let mut state = self.state.lock().map_err(|_| "Log state is unavailable")?;
        if state
            .history
            .as_ref()
            .is_some_and(|history| history.id == id)
        {
            state.history = None;
        }
        Ok(Value::Null)
    }
}
fn status(state: &State) -> Value {
    json!({"epoch":state.epoch,"status":if state.path.is_none(){"no-folder"}else if state.paused{"paused"}else if state.error.is_some(){"error"}else{"watching"},"logsPath":state.path,"detectedPath":state.detected_path,"currentFolder":state.live.folder,"lastEventAt":null,"sessionMode":"unknown","profileId":null,"accountId":null,"message":state.error.as_ref().or(state.watch_warning.as_ref())})
}

pub(crate) fn looks_like_logs(path: &Path) -> bool {
    fs::read_dir(path).is_ok_and(|entries| {
        entries
            .take(10001)
            .flatten()
            .any(|entry| folder_key(&entry.file_name().to_string_lossy()).is_some())
    })
}

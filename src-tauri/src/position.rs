//! Filename-only EFT position tracking. Cleanup requires a fresh live raid lease,
//! explicit settings and repeated metadata/identity checks; no pixels are read.
use notify::{RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{Receiver, SyncSender, TryRecvError, sync_channel},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;

const MAX_ENTRIES: usize = 10_000;
const MAX_PENDING: usize = 32;
const MAX_AGE: u64 = 30 * 60_000;
const RAID_MAX: Duration = Duration::from_secs(75 * 60);
const SETTLE: Duration = Duration::from_millis(1500);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerPosition {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub yaw: f64,
    pub at: u64,
    pub file: String,
}

#[derive(Clone, PartialEq)]
struct Config {
    root: PathBuf,
    track: bool,
    clear: bool,
    paused: bool,
    logs_path: Option<String>,
    generation: u64,
    started_ms: u64,
}
struct Raid {
    since: Instant,
    since_ms: u64,
    mode: String,
    epoch: u64,
}
#[derive(Default)]
struct State {
    config: Option<Config>,
    raid: Option<Raid>,
    raid_epoch: u64,
    event_ids: VecDeque<String>,
    latest: Option<PlayerPosition>,
    position_after: u64,
    error: Option<String>,
    watching: bool,
    root_available: bool,
}
#[derive(Default)]
struct Inner {
    state: Mutex<State>,
    workers: AtomicUsize,
}
struct Worker {
    stop: Arc<AtomicBool>,
    wake: SyncSender<()>,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
    }
}
#[derive(Default)]
pub struct Positions {
    inner: Arc<Inner>,
    worker: Mutex<Option<Worker>>,
}
impl Drop for Positions {
    fn drop(&mut self) {
        self.worker
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn milliseconds(time: SystemTime) -> Option<u64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| value.as_millis().try_into().ok())
}
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 1024
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        && name.rsplit_once('.').is_some_and(|(_, extension)| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "png" | "jpg" | "jpeg" | "bmp"
            )
        })
}
fn number(text: &str) -> Option<f64> {
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    let mut parts = unsigned.split('.');
    let whole = parts.next()?;
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if let Some(fraction) = parts.next()
        && (fraction.is_empty() || !fraction.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    if parts.next().is_some() {
        return None;
    }
    let value = text.parse::<f64>().ok()?;
    value.is_finite().then_some(value)
}
fn numbers<const N: usize>(text: &str) -> Option<[f64; N]> {
    text.split(", ")
        .map(number)
        .collect::<Option<Vec<_>>>()?
        .try_into()
        .ok()
}

/// Same decimal/quaternion convention as electron/position.ts; yaw is not normalized.
pub fn parse_screenshot_name(name: &str, at: u64) -> Option<PlayerPosition> {
    if !plain_name(name) {
        return None;
    }
    let pieces: Vec<_> = name.split('_').collect();
    for pair in pieces.iter().skip(1).collect::<Vec<_>>().windows(3) {
        let Some([x, y, z]) = numbers::<3>(pair[0]) else {
            continue;
        };
        let Some([qx, qy, qz, qw]) = numbers::<4>(pair[1]) else {
            continue;
        };
        let yaw = (2.0 * (qw * qy + qx * qz))
            .atan2(1.0 - 2.0 * (qx * qx + qy * qy))
            .to_degrees();
        if yaw.is_finite() {
            return Some(PlayerPosition {
                x,
                y,
                z,
                yaw,
                at,
                file: name.to_owned(),
            });
        }
    }
    None
}

fn validate_root(root: &Path) -> Result<(), String> {
    let same = |actual: Option<&std::ffi::OsStr>, expected: &str| {
        actual.is_some_and(|part| part.to_string_lossy().eq_ignore_ascii_case(expected))
    };
    if !root.is_absolute()
        || root.as_os_str().len() > 32_768
        || !same(root.file_name(), "Screenshots")
        || !same(
            root.parent().and_then(Path::file_name),
            "Escape from Tarkov",
        )
    {
        return Err("Position tracking requires the known Documents/Escape from Tarkov/Screenshots directory".into());
    }
    Ok(())
}

impl Positions {
    /// Root must come from the native Documents resolver, never renderer input.
    /// Benchmark mode does not inspect it, spawn workers or initialize Shell COM.
    pub fn configure(
        &self,
        app: &tauri::AppHandle,
        settings: &Value,
        root: PathBuf,
    ) -> Result<Value, String> {
        let benchmark = crate::desktop::benchmark_mode();
        if !benchmark {
            validate_root(&root)?;
        }
        let track = !benchmark && settings["trackPosition"] == true;
        let paused = settings["paused"] == true;
        let clear = track && !paused && settings["clearPositionShots"] == true;
        let logs_path = settings["logsPath"].as_str().map(str::to_owned);
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| "Position worker is unavailable")?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Position state is unavailable")?;
        if state.config.as_ref().is_some_and(|old| {
            old.root == root
                && old.track == track
                && old.clear == clear
                && old.paused == paused
                && old.logs_path == logs_path
        }) && (!track
            || worker
                .as_ref()
                .is_some_and(|worker| !worker.stop.load(Ordering::Acquire)))
        {
            return Ok(status(&state));
        }
        // A blocked OS metadata/Shell call must not allow repeated configuration
        // changes to create an unlimited number of detached workers.
        if track && self.inner.workers.load(Ordering::Acquire) >= 2 {
            return Err("Position tracking is still stopping a previous operation. Try the setting again shortly.".into());
        }
        worker.take();
        let generation = state
            .config
            .as_ref()
            .map_or(1, |old| old.generation.saturating_add(1));
        let changed_root = state.config.as_ref().is_none_or(|old| old.root != root);
        let config = Config {
            root,
            track,
            clear,
            paused,
            logs_path,
            generation,
            started_ms: now_ms(),
        };
        state.config = Some(config.clone());
        state.raid = None;
        state.raid_epoch = state.raid_epoch.saturating_add(1);
        state.event_ids.clear();
        state.watching = false;
        state.root_available = false;
        state.error = None;
        if changed_root || !track {
            state.latest = None;
        }
        if generation > 1 {
            state.position_after = now_ms();
        }
        drop(state);
        if track {
            let (tx, rx) = sync_channel(1);
            let stop = Arc::new(AtomicBool::new(false));
            let inner = Arc::clone(&self.inner);
            let handle = app.clone();
            let thread_stop = Arc::clone(&stop);
            let thread_wake = tx.clone();
            inner.workers.fetch_add(1, Ordering::AcqRel);
            if let Err(error) = std::thread::Builder::new()
                .name("screenshot-positions".into())
                .spawn(move || {
                    struct Active(Arc<Inner>);
                    impl Drop for Active {
                        fn drop(&mut self) {
                            self.0.workers.fetch_sub(1, Ordering::AcqRel);
                        }
                    }
                    let _active = Active(Arc::clone(&inner));
                    run(handle, inner, config, rx, thread_wake, thread_stop);
                })
            {
                self.inner.workers.fetch_sub(1, Ordering::AcqRel);
                return Err(format!("Cannot start position tracking: {error}"));
            }
            *worker = Some(Worker { stop, wake: tx });
        }
        drop(worker);
        self.status()
    }

    pub fn status(&self) -> Result<Value, String> {
        self.inner
            .state
            .lock()
            .map(|state| status(&state))
            .map_err(|_| "Position state is unavailable".into())
    }

    /// Run on the host's blocking command worker; reads names/attributes only.
    pub fn latest(&self) -> Result<Option<PlayerPosition>, String> {
        if crate::desktop::benchmark_mode() {
            return Ok(None);
        }
        let (config, cached, after, epoch) = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| "Position state is unavailable")?;
            (
                state.config.clone(),
                state.latest.clone(),
                state.position_after,
                state.raid_epoch,
            )
        };
        let Some(config) = config else {
            return Ok(None);
        };
        if !config.track {
            return Ok(None);
        }
        let snapshot = snapshot(&config.root, || false)?;
        let current = now_ms();
        let best = [snapshot.latest, cached]
            .into_iter()
            .flatten()
            .filter(|position| position.at >= after && fresh(position.at, current, MAX_AGE))
            .max_by_key(|position| position.at);
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Position state is unavailable")?;
        if state.raid_epoch != epoch
            || state.position_after != after
            || state
                .config
                .as_ref()
                .is_none_or(|now| now.generation != config.generation)
        {
            return Ok(None);
        }
        state.latest = best.clone();
        Ok(best)
    }

    pub fn revoke(&self) -> Result<(), String> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Position state is unavailable")?;
        state.raid = None;
        state.raid_epoch = state.raid_epoch.saturating_add(1);
        state.latest = None;
        state.position_after = now_ms();
        Ok(())
    }

    /// Accept only main-window parsed log events. Unknown/stale live contexts
    /// revoke cleanup; history never starts or extends a raid lease.
    pub fn note_game_event(&self, event: &Value) -> Result<(), String> {
        if crate::desktop::benchmark_mode() {
            return Ok(());
        }
        if event["historical"] == true {
            return Ok(());
        }
        if event["historical"] != false {
            return Err("Missing live-event attribution".into());
        }
        let kind = event["kind"].as_str().ok_or("Missing event kind")?;
        if !matches!(
            kind,
            "sessionMode"
                | "profile"
                | "gameVersion"
                | "mapLoading"
                | "raidMatched"
                | "raidStarting"
                | "raidStarted"
                | "raidEnded"
                | "matchingAborted"
        ) {
            return Ok(());
        }
        let id = event["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 512)
            .ok_or("Invalid event identity")?;
        let mode = event["mode"].as_str().unwrap_or("unknown");
        let at = event["at"].as_u64().ok_or("Invalid event timestamp")?;
        let current = now_ms();
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| "Position state is unavailable")?;
        if state.event_ids.iter().any(|known| known == id) {
            return Ok(());
        }
        state.event_ids.push_back(id.to_owned());
        if state.event_ids.len() > 256 {
            state.event_ids.pop_front();
        }
        let trusted = matches!(mode, "pve" | "regular" | "seasonal")
            && at.abs_diff(current) <= 120_000
            && state.config.as_ref().is_some_and(|config| config.clear);
        // Position context follows raid boundaries even when cleanup is disabled.
        state.latest = None;
        state.position_after = current;
        if !trusted
            || matches!(
                kind,
                "sessionMode" | "profile" | "gameVersion" | "raidEnded" | "matchingAborted"
            )
        {
            state.raid = None;
            state.raid_epoch = state.raid_epoch.saturating_add(1);
        } else if kind == "mapLoading"
            || state
                .raid
                .as_ref()
                .is_none_or(|raid| raid.mode != mode || raid.since.elapsed() >= RAID_MAX)
        {
            state.raid_epoch = state.raid_epoch.saturating_add(1);
            state.raid = Some(Raid {
                since: Instant::now(),
                since_ms: current,
                mode: mode.to_owned(),
                epoch: state.raid_epoch,
            });
        }
        drop(state);
        if let Ok(worker) = self.worker.lock()
            && let Some(worker) = worker.as_ref()
        {
            let _ = worker.wake.try_send(());
        }
        Ok(())
    }
}

fn status(state: &State) -> Value {
    json!({ "tracking": state.config.as_ref().is_some_and(|config| config.track),
        "cleanupEnabled": state.config.as_ref().is_some_and(|config| config.clear),
        "watching": state.watching, "waitingForFolder": state.watching && !state.root_available,
        "message": state.error })
}
fn fresh(at: u64, now: u64, age: u64) -> bool {
    at <= now.saturating_add(5000) && now.saturating_sub(at) <= age
}
fn current(inner: &Inner, config: &Config, stop: &AtomicBool) -> bool {
    !stop.load(Ordering::Acquire)
        && inner.state.lock().is_ok_and(|state| {
            state
                .config
                .as_ref()
                .is_some_and(|now| now.generation == config.generation)
        })
}
fn report_error(app: &tauri::AppHandle, inner: &Inner, config: &Config, message: String) {
    if let Ok(mut state) = inner.state.lock()
        && state
            .config
            .as_ref()
            .is_some_and(|now| now.generation == config.generation)
        && state.error.as_ref() != Some(&message)
    {
        state.error = Some(message.clone());
        let _ = app.emit("position-error", message);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    volume: u32,
    index: u64,
    created: u64,
    modified: u64,
    size: u64,
    links: u32,
}
impl Stamp {
    fn same_file(&self, other: &Self) -> bool {
        (self.volume, self.index, self.created) == (other.volume, other.index, other.created)
    }
}
#[cfg(windows)]
fn stamp(path: &Path) -> Result<Stamp, String> {
    use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
            FILE_SHARE_WRITE, GetFileInformationByHandle,
        },
    };
    let file = fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES.0)
        .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // Only attributes/file identity are requested; screenshot contents are never read.
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(|e| e.to_string())?;
    if info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY.0 | FILE_ATTRIBUTE_REPARSE_POINT.0) != 0 {
        return Err("Screenshot is not a plain regular file".into());
    }
    let ticks = |low: u32, high: u32| (u64::from(high) << 32) | u64::from(low);
    Ok(Stamp {
        volume: info.dwVolumeSerialNumber,
        index: ticks(info.nFileIndexLow, info.nFileIndexHigh),
        created: ticks(
            info.ftCreationTime.dwLowDateTime,
            info.ftCreationTime.dwHighDateTime,
        ),
        modified: ticks(
            info.ftLastWriteTime.dwLowDateTime,
            info.ftLastWriteTime.dwHighDateTime,
        ),
        size: ticks(info.nFileSizeLow, info.nFileSizeHigh),
        links: info.nNumberOfLinks,
    })
}
#[cfg(not(windows))]
fn stamp(path: &Path) -> Result<Stamp, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Screenshot is not a plain regular file".into());
    }
    Ok(Stamp {
        volume: 0,
        index: 0,
        created: metadata.created().ok().and_then(milliseconds).unwrap_or(0),
        modified: metadata.modified().ok().and_then(milliseconds).unwrap_or(0),
        size: metadata.len(),
        links: 1,
    })
}
#[derive(Clone)]
struct Record {
    path: PathBuf,
    position: PlayerPosition,
    stamp: Stamp,
}
struct Snapshot {
    root: Option<(PathBuf, SystemTime)>,
    entries: BTreeMap<String, Record>,
    latest: Option<PlayerPosition>,
}
fn snapshot(root: &Path, cancelled: impl Fn() -> bool) -> Result<Snapshot, String> {
    let mut result = Snapshot {
        root: None,
        entries: BTreeMap::new(),
        latest: None,
    };
    let canonical = match root.canonicalize() {
        Ok(path) => path,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(result),
        Err(error) => return Err(error.to_string()),
    };
    validate_root(&canonical)?;
    let metadata = fs::metadata(&canonical).map_err(|e| e.to_string())?;
    if !metadata.is_dir() {
        return Err("Screenshot directory is not a folder".into());
    }
    result.root = Some((canonical.clone(), metadata.created().unwrap_or(UNIX_EPOCH)));
    let current = now_ms();
    for (count, entry) in fs::read_dir(&canonical)
        .map_err(|e| e.to_string())?
        .enumerate()
    {
        if cancelled() {
            return Err("Position scan cancelled".into());
        }
        if count >= MAX_ENTRIES {
            return Err("Screenshot directory exceeds 10000 entries; move old screenshots aside before enabling position tracking".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if parse_screenshot_name(&name, 0).is_none() {
            continue;
        }
        let path = entry.path();
        let Ok(file_stamp) = stamp(&path) else {
            continue;
        };
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let Some(at) = metadata.modified().ok().and_then(milliseconds) else {
            continue;
        };
        let Some(position) = parse_screenshot_name(&name, at) else {
            continue;
        };
        if fresh(at, current, MAX_AGE) && result.latest.as_ref().is_none_or(|best| at > best.at) {
            result.latest = Some(position.clone());
        }
        result.entries.insert(
            name,
            Record {
                path,
                position,
                stamp: file_stamp,
            },
        );
    }
    Ok(result)
}

struct Cleanup {
    record: Record,
    root: (PathBuf, SystemTime),
    raid_epoch: u64,
    last: Stamp,
    stable: usize,
    tries: usize,
    due: Instant,
}
fn raid_lease(inner: &Inner, config: &Config, at: u64) -> Option<u64> {
    let state = inner.state.lock().ok()?;
    if !state
        .config
        .as_ref()
        .is_some_and(|now| now.generation == config.generation && now.clear)
    {
        return None;
    }
    let raid = state.raid.as_ref()?;
    (raid.since.elapsed() < RAID_MAX
        && at >= raid.since_ms
        && at >= config.started_ms
        && fresh(at, now_ms(), MAX_AGE))
    .then_some(raid.epoch)
}
fn watch_paths(root: &Path) -> BTreeSet<PathBuf> {
    [
        root.parent().and_then(Path::parent),
        root.parent(),
        Some(root),
    ]
    .into_iter()
    .flatten()
    .filter(|path| path.is_dir())
    .map(Path::to_owned)
    .collect()
}

fn run(
    app: tauri::AppHandle,
    inner: Arc<Inner>,
    config: Config,
    rx: Receiver<()>,
    tx: SyncSender<()>,
    stop: Arc<AtomicBool>,
) {
    struct Finished<'a> {
        inner: &'a Inner,
        stop: &'a AtomicBool,
        generation: u64,
    }
    impl Drop for Finished<'_> {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Ok(mut state) = self.inner.state.lock()
                && state
                    .config
                    .as_ref()
                    .is_some_and(|config| config.generation == self.generation)
            {
                state.watching = false;
            }
        }
    }
    let _finished = Finished {
        inner: &inner,
        stop: &stop,
        generation: config.generation,
    };
    let fault = Arc::new(AtomicBool::new(false));
    let mut watcher: Option<notify::RecommendedWatcher> = None;
    let mut watched = BTreeSet::new();
    let mut seen: BTreeMap<String, Record> = BTreeMap::new();
    let mut previous_root = None;
    let mut primed = false;
    let mut pending: BTreeMap<String, Cleanup> = BTreeMap::new();
    let mut dirty = true;
    let mut fault_window = Instant::now();
    let mut faults = 0;
    while current(&inner, &config, &stop) {
        if dirty {
            let failed = fault.swap(false, Ordering::AcqRel);
            if failed {
                if fault_window.elapsed() > Duration::from_secs(60) {
                    fault_window = Instant::now();
                    faults = 0;
                }
                faults += 1;
                if faults >= 3 {
                    report_error(&app, &inner, &config,
                        "Position filesystem notifications repeatedly failed; reconnect position tracking. No pending screenshots were recycled.".into());
                    return;
                }
            }
            let desired = watch_paths(&config.root);
            if desired != watched || failed || watcher.is_none() {
                watcher.take();
                let signal = tx.clone();
                let failed = Arc::clone(&fault);
                let expected = config.root.clone();
                let creation =
                    notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                        match event {
                            Ok(event) if matches!(event.kind, notify::EventKind::Access(_)) => {
                                return;
                            }
                            Ok(event)
                                if !event.paths.iter().any(|path| {
                                    path == &expected
                                        || path.parent() == Some(expected.as_path())
                                        || Some(path.as_path()) == expected.parent()
                                        || Some(path.as_path())
                                            == expected.parent().and_then(Path::parent)
                                }) =>
                            {
                                return;
                            }
                            Err(_) => {
                                failed.store(true, Ordering::Release);
                            }
                            _ => {}
                        }
                        let _ = signal.try_send(());
                    })
                    .and_then(|mut watch| {
                        for path in &desired {
                            watch.watch(path, RecursiveMode::NonRecursive)?;
                        }
                        Ok(watch)
                    });
                match creation {
                    Ok(watch) if !desired.is_empty() => {
                        watcher = Some(watch);
                        watched = desired;
                    }
                    Ok(_) => {
                        watched.clear();
                        report_error(&app, &inner, &config, "The Documents directory is unavailable; reconnect position tracking when it returns".into());
                    }
                    Err(error) => {
                        watched.clear();
                        report_error(
                            &app,
                            &inner,
                            &config,
                            format!(
                                "Position watcher unavailable: {error}. Reconnect position tracking."
                            ),
                        );
                    }
                }
            }
            match snapshot(&config.root, || !current(&inner, &config, &stop)) {
                Ok(snapshot) => {
                    let recovered = previous_root != snapshot.root;
                    for (name, record) in &snapshot.entries {
                        if !current(&inner, &config, &stop) {
                            return;
                        }
                        let new = seen
                            .get(name)
                            .is_none_or(|old| !old.stamp.same_file(&record.stamp));
                        if !primed || !new || !fresh(record.position.at, now_ms(), MAX_AGE) {
                            continue;
                        }
                        if let Ok(mut state) = inner.state.lock()
                            && state
                                .config
                                .as_ref()
                                .is_some_and(|now| now.generation == config.generation)
                            && state
                                .latest
                                .as_ref()
                                .is_none_or(|old| record.position.at >= old.at)
                            && record.position.at >= state.position_after
                        {
                            state.latest = Some(record.position.clone());
                            let _ = app.emit("position-new", &record.position);
                        }
                        if !recovered
                            && pending.len() < MAX_PENDING
                            && let (Some(root), Some(raid_epoch)) = (
                                snapshot.root.clone(),
                                raid_lease(&inner, &config, record.position.at),
                            )
                        {
                            pending.insert(
                                name.clone(),
                                Cleanup {
                                    record: record.clone(),
                                    root,
                                    raid_epoch,
                                    last: record.stamp.clone(),
                                    stable: 0,
                                    tries: 0,
                                    due: Instant::now() + SETTLE,
                                },
                            );
                        }
                    }
                    if let Ok(mut state) = inner.state.lock()
                        && state
                            .config
                            .as_ref()
                            .is_some_and(|now| now.generation == config.generation)
                    {
                        state.watching = watcher.is_some();
                        state.root_available = snapshot.root.is_some();
                        if !primed {
                            state.latest = snapshot
                                .latest
                                .filter(|position| position.at >= state.position_after);
                        }
                        if watcher.is_some() {
                            state.error = None;
                        }
                    }
                    previous_root = snapshot.root;
                    seen = snapshot.entries;
                    primed = true;
                }
                Err(error) => {
                    pending.clear();
                    report_error(&app, &inner, &config, error);
                }
            }
            dirty = false;
        }
        let due: Vec<_> = pending
            .iter()
            .filter(|(_, job)| job.due <= Instant::now())
            .map(|(name, _)| name.clone())
            .collect();
        for name in due {
            let Some(mut job) = pending.remove(&name) else {
                continue;
            };
            if !current(&inner, &config, &stop)
                || raid_lease(&inner, &config, job.record.position.at) != Some(job.raid_epoch)
            {
                continue;
            }
            let checked = checked_cleanup(&config.root, &job);
            let Ok(observed) = checked else { continue };
            job.tries += 1;
            job.stable = if observed == job.last && observed.size > 0 {
                job.stable + 1
            } else {
                0
            };
            job.last = observed;
            if job.stable >= 2 {
                // Last scope/identity/time/settings checks are immediately before
                // Shell's recycle-only operation. No permanent-delete fallback.
                if current(&inner, &config, &stop)
                    && raid_lease(&inner, &config, job.record.position.at) == Some(job.raid_epoch)
                    && checked_cleanup(&config.root, &job).is_ok_and(|stamp| stamp == job.last)
                    && let Err(error) = recycle(&job.record.path, || {
                        current(&inner, &config, &stop)
                            && raid_lease(&inner, &config, job.record.position.at)
                                == Some(job.raid_epoch)
                            && checked_cleanup(&config.root, &job)
                                .is_ok_and(|stamp| stamp == job.last)
                    })
                {
                    report_error(
                        &app,
                        &inner,
                        &config,
                        format!(
                            "Position screenshot cleanup failed: {error}. No permanent-delete fallback was attempted; check the original folder and Recycle Bin."
                        ),
                    );
                }
            } else if job.tries < 10 {
                job.due = Instant::now() + SETTLE;
                pending.insert(name, job);
            }
        }
        if !current(&inner, &config, &stop) {
            break;
        }
        let received = match pending.values().map(|job| job.due).min() {
            Some(due) => match rx.recv_timeout(due.saturating_duration_since(Instant::now())) {
                Ok(()) => true,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => false,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            },
            None => match rx.recv() {
                Ok(()) => true,
                Err(_) => break,
            },
        };
        if received {
            dirty = true;
            loop {
                match rx.try_recv() {
                    Ok(()) => {}
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => break,
                }
            }
        }
    }
}

fn checked_cleanup(root: &Path, job: &Cleanup) -> Result<Stamp, String> {
    let canonical = root.canonicalize().map_err(|e| e.to_string())?;
    if canonical != job.root.0
        || fs::metadata(&canonical)
            .and_then(|m| m.created())
            .map_err(|e| e.to_string())?
            != job.root.1
        || job.record.path.parent() != Some(canonical.as_path())
        || !plain_name(&job.record.position.file)
        || job.record.path.file_name().and_then(|name| name.to_str())
            != Some(job.record.position.file.as_str())
        || job
            .record
            .path
            .canonicalize()
            .map_err(|e| e.to_string())?
            .parent()
            != Some(canonical.as_path())
    {
        return Err("Screenshot scope changed".into());
    }
    let current = stamp(&job.record.path)?;
    if !current.same_file(&job.record.stamp) || current.links != 1 {
        return Err("Screenshot identity changed".into());
    }
    Ok(current)
}

#[cfg(windows)]
fn recycle(path: &Path, permitted: impl Fn() -> bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::{
        Win32::{
            System::Com::{
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
                CoUninitialize, IBindCtx,
            },
            UI::Shell::{
                FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOFX_ADDUNDORECORD,
                FOFX_EARLYFAILURE, FOFX_RECYCLEONDELETE, FileOperation, IFileOperation,
                IFileOperationProgressSink, IShellItem, SHCreateItemFromParsingName,
            },
        },
        core::{IUnknown, PCWSTR},
    };
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                CoUninitialize();
            }
        }
    }
    let mut name: Vec<u16> = path.as_os_str().encode_wide().collect();
    // Canonicalization uses a verbatim Win32 prefix. Shell parsing expects the
    // ordinary drive/UNC spelling; this conversion does not change the target.
    if name.starts_with(&[92, 92, 63, 92, 85, 78, 67, 92]) {
        drop(name.splice(..8, [92, 92]));
    } else if name.starts_with(&[92, 92, 63, 92]) {
        drop(name.drain(..4));
    }
    name.push(0);
    // This function is called only on the dedicated position worker. COM
    // references drop before the balanced apartment guard on every exit.
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED)
            .ok()
            .map_err(|e| e.to_string())?;
        let _apartment = Apartment;
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None::<&IUnknown>, CLSCTX_INPROC_SERVER)
                .map_err(|e| e.to_string())?;
        operation
            .SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOFX_ADDUNDORECORD
                    | FOFX_EARLYFAILURE
                    | FOF_NOCONFIRMATION
                    | FOF_NOERRORUI
                    | FOF_SILENT,
            )
            .map_err(|e| e.to_string())?;
        let item: IShellItem =
            SHCreateItemFromParsingName(PCWSTR(name.as_ptr()), None::<&IBindCtx>)
                .map_err(|e| e.to_string())?;
        operation
            .DeleteItem(&item, None::<&IFileOperationProgressSink>)
            .map_err(|e| e.to_string())?;
        // DeleteItem declares work only. Recheck after potentially slow Shell
        // initialization and immediately before the actual operation starts.
        if !permitted() {
            return Err("Position cleanup was cancelled or screenshot identity changed".into());
        }
        operation.PerformOperations().map_err(|e| e.to_string())?;
        if operation
            .GetAnyOperationsAborted()
            .map_err(|e| e.to_string())?
            .as_bool()
        {
            return Err("Windows cancelled the recycle operation".into());
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn recycle(_path: &Path, _permitted: impl Fn() -> bool) -> Result<(), String> {
    Err("Recycle-only position cleanup is supported on Windows".into())
}

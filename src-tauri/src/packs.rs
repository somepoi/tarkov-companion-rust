//! Bounded, data-only TCPK1 installation. Call blocking methods off the UI/runtime thread.
//! A compiled manifest selects exact fork release bytes; incomplete jobs are never served.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

const MAGIC: &[u8] = b"TCPK1\n";
const MAX_PACK: u64 = 300 * 1024 * 1024;
const MAX_FILE: u64 = 256 * 1024 * 1024;
const MAX_HEADER: usize = 8 * 1024 * 1024;
const MAX_MARKER: usize = 16 * 1024 * 1024;
const MAX_FILES: usize = 50_000;
const READY: &str = ".complete";
const RELEASES: &str = "https://github.com/somepoi/tarkov-companion-rust/releases/download";
static NEXT_JOB: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct PackInfo {
    file: String,
    sha256: String,
    size: u64,
    files: usize,
    label: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    packs: BTreeMap<String, PackInfo>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Header {
    files: Vec<Entry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    size: u64,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StoredFile {
    size: u64,
    sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Marker {
    pack_sha256: String,
    files: BTreeMap<String, StoredFile>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Pointer {
    directory: String,
    sha256: String,
}
struct Installed {
    directory: PathBuf,
    files: BTreeMap<String, StoredFile>,
}

#[derive(Clone, Serialize)]
pub struct PackProgress {
    pub name: String,
    pub label: String,
    pub received: u64,
    pub total: u64,
    pub state: &'static str,
}

pub struct Packs {
    data_root: PathBuf,
    root: PathBuf,
    manifest: BTreeMap<String, PackInfo>,
    version: String,
    // Serialize installation (including duplicate requests); recheck after acquiring.
    install: Mutex<()>,
    requests: AtomicUsize,
    installed: Mutex<BTreeMap<String, Installed>>,
    invalid: Mutex<BTreeSet<String>>,
}

fn known(name: &str) -> bool {
    matches!(name, "scan" | "lighthouse")
}
fn hash_name(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
fn unique() -> String {
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{at:x}-{:x}-{:x}",
        std::process::id(),
        NEXT_JOB.fetch_add(1, Ordering::Relaxed)
    )
}
fn io(error: std::io::Error) -> String {
    error.to_string()
}
fn bounded_json<T: serde::de::DeserializeOwned>(file: &Path, limit: usize) -> Result<T, String> {
    let mut bytes = Vec::new();
    File::open(file)
        .map_err(io)?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(io)?;
    if bytes.len() > limit {
        return Err("Content-pack metadata exceeds its byte budget".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
fn reserved(segment: &str) -> bool {
    let base = segment
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || base
            .strip_prefix("COM")
            .or_else(|| base.strip_prefix("LPT"))
            .is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9'))
}
pub(crate) const LIGHTHOUSE_DRAWING: &str = "tiles/lighthouse-re3mr/drawing-2026.svg";

fn relative(name: &str, value: &str) -> Result<String, String> {
    if value.len() > 240 || value.is_empty() || value.contains('\\') || value.contains("..") {
        return Err("Invalid content-pack relative path".into());
    }
    let components: Vec<_> = value.split('/').collect();
    if components.len() > 32
        || components.iter().any(|part| {
            part.is_empty()
                || !part.as_bytes()[0].is_ascii_alphanumeric()
                || part.ends_with('.')
                || reserved(part)
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-' | b'.'))
        })
    {
        return Err("Unsafe Windows content-pack path".into());
    }
    let path = value.to_ascii_lowercase();
    let extension = path
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .unwrap_or_default();
    let allowed = match name {
        "scan" => path.starts_with("scan/") && matches!(extension, "json" | "bin"),
        "lighthouse" => {
            path == LIGHTHOUSE_DRAWING
                || (path.starts_with("tiles/lighthouse-re3mr/")
                    && matches!(
                        extension,
                        "png" | "jpg" | "jpeg" | "webp" | "json" | "txt" | "md"
                    ))
        }
        _ => false,
    };
    if !allowed {
        return Err("Pack entry is outside its data-only resource namespace".into());
    }
    Ok(path)
}
fn required(name: &str, files: &BTreeSet<String>) -> bool {
    match name {
        "scan" => [
            "scan/fingerprints.json",
            "scan/fingerprints.bin",
            "scan/manifest.json",
            "scan/source-manifest.json",
        ]
        .iter()
        .all(|file| files.contains(*file)),
        "lighthouse" => {
            files.contains("tiles/lighthouse-re3mr/0/0/0.png") && files.contains(LIGHTHOUSE_DRAWING)
        }
        _ => false,
    }
}
fn validate_entries(
    name: &str,
    info: &PackInfo,
    header_size: usize,
    entries: &mut [Entry],
) -> Result<(), String> {
    if entries.is_empty() || entries.len() > MAX_FILES || entries.len() != info.files {
        return Err("Pack file count does not match the compiled manifest".into());
    }
    let mut names = BTreeSet::new();
    let mut total = (MAGIC.len() + 4 + header_size) as u64;
    for entry in entries.iter_mut() {
        entry.path = relative(name, &entry.path)?;
        if entry.size > MAX_FILE || !names.insert(entry.path.clone()) {
            return Err("Duplicate or oversized pack entry".into());
        }
        total = total
            .checked_add(entry.size)
            .ok_or("Pack length overflow")?;
        if total > info.size {
            return Err("Pack entries exceed the expected length".into());
        }
    }
    for path in &names {
        let mut parent = path.as_str();
        while let Some((prefix, _)) = parent.rsplit_once('/') {
            if names.contains(prefix) {
                return Err("A pack file is also used as a directory".into());
            }
            parent = prefix;
        }
    }
    if total != info.size || !required(name, &names) {
        return Err("Pack contents are incomplete or their size does not add up".into());
    }
    Ok(())
}

impl Packs {
    /// Parses compiled metadata only; no directory creation, download or game-folder access.
    pub fn new(data_dir: PathBuf, manifest_json: &str, version: &str) -> Result<Self, String> {
        if manifest_json.len() > 64 * 1024
            || version.is_empty()
            || version.len() > 64
            || !version.as_bytes()[0].is_ascii_digit()
            || !version
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'+'))
        {
            return Err("Invalid compiled content-pack metadata or version".into());
        }
        let manifest: Option<Manifest> =
            serde_json::from_str(manifest_json).map_err(|e| e.to_string())?;
        let packs = manifest.map(|m| m.packs).unwrap_or_default();
        if packs.len() > 2 {
            return Err("Unknown compiled content pack".into());
        }
        for (name, info) in &packs {
            if !known(name)
                || !hash_name(&info.sha256)
                || info.size < 10
                || info.size > MAX_PACK
                || info.files == 0
                || info.files > MAX_FILES
                || info.label.is_empty()
                || info.label.len() > 256
                || info.file != format!("{}-{}.tcpack", name, &info.sha256[..12])
            {
                return Err("Invalid compiled content-pack descriptor".into());
            }
        }
        let data_root = data_dir.canonicalize().map_err(io)?;
        Ok(Self {
            root: data_root.join("packs"),
            data_root,
            manifest: packs,
            version: version.into(),
            install: Mutex::new(()),
            requests: AtomicUsize::new(0),
            installed: Mutex::new(BTreeMap::new()),
            invalid: Mutex::new(BTreeSet::new()),
        })
    }
    pub fn enabled(&self) -> bool {
        !self.manifest.is_empty()
    }
    pub fn contains(&self, name: &str) -> bool {
        self.manifest.contains_key(name)
    }

    /// Keep installation excluded through discovery and any confirmed recycling.
    pub fn with_cleanup<T>(
        &self,
        run: impl FnOnce(Vec<PathBuf>) -> Result<T, String>,
    ) -> Result<T, String> {
        let _guard = self
            .install
            .try_lock()
            .map_err(|_| "Content-pack installation is busy; retry cleanup later")?;
        if self.requests.load(Ordering::Acquire) != 0 {
            return Err("Content-pack requests are pending; retry cleanup later".into());
        }
        let mut candidates = Vec::new();
        if let Some(root) = self.root(false)? {
            let installed = self
                .installed
                .lock()
                .map_err(|_| "Pack state unavailable")?;
            for (index, entry) in fs::read_dir(&root).map_err(io)?.enumerate() {
                if index >= 4096 {
                    return Err("Content-pack cache exceeds cleanup inspection budget".into());
                }
                let entry = entry.map_err(io)?;
                if candidates.len() >= 128 {
                    return Err("Too many old packs; cleanup was not started".into());
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let partial = name.starts_with(".partial-");
                let body = name.strip_prefix(".partial-").unwrap_or(&name);
                let Some((kind, rest)) = body.split_once('-') else {
                    continue;
                };
                if !known(kind) {
                    continue;
                }
                let pieces: Vec<_> = rest.split('-').collect();
                let hex = |s: &str| {
                    !s.is_empty()
                        && s.len() <= 32
                        && s.bytes()
                            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                };
                let valid = if partial {
                    pieces.len() == 3 && pieces.iter().all(|s| hex(s))
                } else {
                    pieces.len() == 4 && pieces[0].len() == 16 && pieces.iter().all(|s| hex(s))
                };
                if !valid
                    || (!partial
                        && self
                            .manifest
                            .get(kind)
                            .is_some_and(|info| pieces[0] == &info.sha256[..16]))
                    || installed
                        .values()
                        .any(|pack| pack.directory == entry.path())
                {
                    continue;
                }
                candidates.push(entry.path());
            }
        }
        run(candidates)
    }

    fn root(&self, create: bool) -> Result<Option<PathBuf>, String> {
        if !self.root.exists() {
            if !create {
                return Ok(None);
            }
            fs::create_dir(&self.root).map_err(io)?;
        }
        let root = self.root.canonicalize().map_err(io)?;
        if root != self.root || !root.starts_with(&self.data_root) || !root.is_dir() {
            return Err("Content-pack cache is redirected outside its expected directory".into());
        }
        Ok(Some(root))
    }
    fn pointer(&self, name: &str, info: &PackInfo) -> PathBuf {
        self.root
            .join(format!(".current-{name}-{}.json", &info.sha256[..16]))
    }
    fn invalidate(&self, name: &str) {
        if let Ok(mut current) = self.installed.lock() {
            current.remove(name);
        }
        if let Ok(mut invalid) = self.invalid.lock() {
            invalid.insert(name.to_owned());
        }
    }
    fn load_current(&self, name: &str, info: &PackInfo) -> Result<bool, String> {
        if self
            .invalid
            .lock()
            .map_err(|_| "Pack state unavailable")?
            .contains(name)
        {
            return Ok(false);
        }
        if self
            .installed
            .lock()
            .map_err(|_| "Pack state unavailable")?
            .contains_key(name)
        {
            return Ok(true);
        }
        let Some(root) = self.root(false)? else {
            return Ok(false);
        };
        let load = || -> Result<Installed, String> {
            let pointer_file = self.pointer(name, info).canonicalize().map_err(io)?;
            if pointer_file.parent() != Some(root.as_path()) {
                return Err("Pack pointer is outside the expected cache directory".into());
            }
            let pointer: Pointer = bounded_json(&pointer_file, 4096)?;
            let prefix = format!("{name}-{}-", &info.sha256[..16]);
            if pointer.sha256 != info.sha256
                || !pointer.directory.starts_with(&prefix)
                || pointer.directory.len() > 128
                || !pointer
                    .directory
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-')
            {
                return Err("Invalid installed content-pack pointer".into());
            }
            let directory = root.join(&pointer.directory).canonicalize().map_err(io)?;
            if directory.parent() != Some(root.as_path()) || !directory.is_dir() {
                return Err("Invalid pack directory".into());
            }
            let marker_file = directory.join(READY).canonicalize().map_err(io)?;
            if !marker_file.starts_with(&directory) {
                return Err("Pack marker is outside the installed directory".into());
            }
            let marker: Marker = bounded_json(&marker_file, MAX_MARKER)?;
            if marker.pack_sha256 != info.sha256
                || marker.files.len() != info.files
                || marker.files.len() > MAX_FILES
            {
                return Err("Installed pack metadata differs from this build".into());
            }
            let mut total = 0_u64;
            let mut names = BTreeSet::new();
            for (file, expected) in &marker.files {
                if relative(name, file)? != *file
                    || !hash_name(&expected.sha256)
                    || expected.size > MAX_FILE
                    || !names.insert(file.clone())
                {
                    return Err("Invalid installed file metadata".into());
                }
                total = total
                    .checked_add(expected.size)
                    .ok_or("Installed size overflow")?;
                if total > info.size {
                    return Err("Installed files exceed the expected pack size".into());
                }
                let path = directory.join(file).canonicalize().map_err(io)?;
                if !path.starts_with(&directory)
                    || !path.is_file()
                    || fs::metadata(path).map_err(io)?.len() != expected.size
                {
                    return Err("An installed pack file is missing or changed".into());
                }
            }
            if !required(name, &names) {
                return Err("Installed pack is incomplete".into());
            }
            Ok(Installed {
                directory,
                files: marker.files,
            })
        };
        match load() {
            Ok(installed) => {
                self.installed
                    .lock()
                    .map_err(|_| "Pack state unavailable")?
                    .insert(name.into(), installed);
                Ok(true)
            }
            Err(_) => Ok(false), // Retain malformed/old data; a new install gets another directory.
        }
    }

    /// Blocking and serialized. A duplicate request waits and reuses the completed install.
    /// Without compiled pack metadata this is a no-op, leaving bundled/dev content to the caller.
    pub fn ensure(
        &self,
        name: &str,
        local_archive: Option<&Path>,
        progress: impl Fn(PackProgress),
    ) -> Result<bool, String> {
        if !known(name) {
            return Err("Unknown content pack".into());
        }
        let Some(info) = self.manifest.get(name) else {
            return Ok(false);
        };
        self.requests
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 4).then_some(count + 1)
            })
            .map_err(
                |_| "Content-pack requests are busy; retry when the current installation finishes",
            )?;
        let _request = RequestLease(&self.requests);
        let _guard = self
            .install
            .lock()
            .map_err(|_| "Pack installation state unavailable")?;
        if self.load_current(name, info)? {
            return Ok(false);
        }
        let local_file = local_archive
            .map(|path| {
                let matches =
                    |metadata: fs::Metadata| metadata.is_file() && metadata.len() == info.size;
                let wrong_file =
                    || format!("Choose {} from the same release as this app", info.file);
                if !matches(fs::metadata(path).map_err(io)?) {
                    return Err(wrong_file());
                }
                let file = File::open(path).map_err(io)?;
                if !matches(file.metadata().map_err(io)?) {
                    return Err(wrong_file());
                }
                Ok(file)
            })
            .transpose()?;
        let root = self.root(true)?.ok_or("Pack directory unavailable")?;
        let id = unique();
        let stage = root.join(format!(".partial-{name}-{id}"));
        fs::create_dir(&stage).map_err(io)?;
        let stage = stage.canonicalize().map_err(io)?;
        if stage.parent() != Some(root.as_path()) {
            return Err("Invalid content-pack staging directory".into());
        }
        let archive = stage.join("archive.tcpack");
        let emit = |state, received| {
            progress(PackProgress {
                name: name.into(),
                label: info.label.clone(),
                received,
                total: info.size,
                state,
            })
        };
        if let Some(file) = local_file {
            emit("installing", 0);
            Self::stage_archive(info, file, &archive, |received| {
                emit("installing", received)
            })?;
        } else {
            emit("downloading", 0);
            self.download(info, &archive, |received| emit("downloading", received))?;
        }
        emit("installing", info.size);
        let content = stage.join("content");
        fs::create_dir(&content).map_err(io)?;
        let marker = unpack(name, info, &archive, &content)?;
        let ready = serde_json::to_vec(&marker).map_err(|e| e.to_string())?;
        if ready.len() > MAX_MARKER {
            return Err("Installed pack index exceeds its metadata budget".into());
        }
        write_new(&content.join(READY), &ready)?;
        let folder = format!("{name}-{}-{id}", &info.sha256[..16]);
        let destination = root.join(&folder);
        // Source and final parent are resolved inside the native profile immediately before moving.
        if content.canonicalize().map_err(io)?.parent() != Some(stage.as_path())
            || root.canonicalize().map_err(io)? != root
            || destination.parent() != Some(root.as_path())
            || destination.exists()
        {
            return Err("Content-pack publication path changed".into());
        }
        fs::rename(&content, &destination).map_err(io)?;
        let pointer = serde_json::to_vec(&Pointer {
            directory: folder,
            sha256: info.sha256.clone(),
        })
        .map_err(|e| e.to_string())?;
        let temporary = root.join(format!(".pointer-{id}.tmp"));
        write_new(&temporary, &pointer)?;
        fs::rename(&temporary, self.pointer(name, info)).map_err(io)?;
        self.invalid
            .lock()
            .map_err(|_| "Pack state unavailable")?
            .remove(name);
        self.installed
            .lock()
            .map_err(|_| "Pack state unavailable")?
            .insert(
                name.into(),
                Installed {
                    directory: destination,
                    files: marker.files,
                },
            );
        // Only this completed job's now-redundant archive file is removed. No directory,
        // previous installation, original app cache or user screenshot is deleted.
        if archive
            .canonicalize()
            .ok()
            .as_deref()
            .is_some_and(|path| path.parent() == Some(stage.as_path()))
        {
            let _ = fs::remove_file(archive);
        }
        emit("done", info.size);
        Ok(true)
    }

    fn download(
        &self,
        info: &PackInfo,
        destination: &Path,
        progress: impl Fn(u64),
    ) -> Result<(), String> {
        let target = self.download_url(info)?;
        let staging = loopback(&target);
        let redirect = reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 8 || !safe_url(attempt.url(), staging) {
                attempt.error(
                    "Content-pack redirect is outside the allowed HTTPS/CDN or loopback scope",
                )
            } else {
                attempt.follow()
            }
        });
        let client = reqwest::blocking::Client::builder()
            .no_gzip()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(180))
            .redirect(redirect)
            .user_agent("TarkovCompanionRust/content-packs")
            .build()
            .map_err(|e| format!("Cannot initialize content download: {e}"))?;
        let response = client
            .get(target)
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .send()
            .map_err(|e| format!("Content pack could not be downloaded ({}). Import a matching pack in Settings → Desktop app.", e.without_url()))?;
        if !response.status().is_success() {
            return Err(format!(
                "Content pack unavailable for this fork release (HTTP {}). Import a matching pack in Settings → Desktop app.",
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|size| size != info.size)
        {
            return Err("Content-pack response length differs from this build".into());
        }
        Self::stage_archive(info, response, destination, progress)
    }

    fn stage_archive(
        info: &PackInfo,
        mut input: impl Read,
        destination: &Path,
        progress: impl Fn(u64),
    ) -> Result<(), String> {
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(destination)
            .map_err(io)?;
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut received = 0_u64;
        let mut reported = 0_u64;
        loop {
            let count = input
                .read(&mut buffer)
                .map_err(|error| format!("Content-pack stream interrupted ({:?})", error.kind()))?;
            if count == 0 {
                break;
            }
            received += count as u64;
            if received > info.size {
                return Err("Content-pack archive exceeds its expected size".into());
            }
            output.write_all(&buffer[..count]).map_err(io)?;
            hash.update(&buffer[..count]);
            if received - reported >= 512 * 1024 {
                progress(received);
                reported = received;
            }
        }
        output.sync_all().map_err(io)?;
        if received != info.size || format!("{:x}", hash.finalize()) != info.sha256 {
            return Err(format!(
                "Content pack is incomplete or differs from this build. Expected {}.",
                info.file
            ));
        }
        Ok(())
    }
    fn download_url(&self, info: &PackInfo) -> Result<Url, String> {
        let base = match std::env::var("TC_PACKS_BASE_URL") {
            Ok(value) => {
                if value.len() > 4096 {
                    return Err("Staging content-pack base URL exceeds its length limit".into());
                }
                let parsed =
                    Url::parse(&value).map_err(|_| "Invalid staging content-pack base URL")?;
                if parsed.query().is_some()
                    || !safe_url(&parsed, true)
                    || (!loopback(&parsed)
                        && (parsed.host_str() != Some("github.com")
                            || !parsed
                                .path()
                                .starts_with("/somepoi/tarkov-companion-rust/releases/download/")))
                {
                    return Err("Content-pack override must be the fork release directory or explicit loopback staging".into());
                }
                parsed
            }
            Err(std::env::VarError::NotPresent) => {
                Url::parse(&format!("{RELEASES}/v{}/", self.version)).map_err(|e| e.to_string())?
            }
            Err(_) => return Err("Invalid staging content-pack base URL".into()),
        };
        let mut target = base;
        target
            .path_segments_mut()
            .map_err(|_| "Invalid content-pack base URL")?
            .pop_if_empty()
            .push(&info.file);
        if !safe_url(&target, loopback(&target)) {
            return Err("Invalid content-pack URL".into());
        }
        Ok(target)
    }

    /// Only compiled, completed pack entries are returned. None means use bundled/dev content.
    pub fn read_resource(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
        self.read_resource_limited(path, 64 * 1024 * 1024)
    }

    pub fn read_resource_limited(&self, path: &str, limit: u64) -> Result<Option<Vec<u8>>, String> {
        let name = if path.starts_with("scan/") {
            "scan"
        } else if path.starts_with("tiles/lighthouse-re3mr/") {
            "lighthouse"
        } else {
            return Ok(None);
        };
        let relative = relative(name, path)?;
        let Some(info) = self.manifest.get(name) else {
            return Ok(None);
        };
        if !self.load_current(name, info)? {
            return Ok(None);
        }
        let (root, expected) = {
            let current = self
                .installed
                .lock()
                .map_err(|_| "Pack state unavailable")?;
            let installed = current.get(name).ok_or("Installed pack state changed")?;
            let expected = installed
                .files
                .get(&relative)
                .ok_or("Resource is not part of the compiled content pack")?;
            (installed.directory.clone(), expected.clone())
        };
        if expected.size > limit {
            return Err("Content resource exceeds this transport's size limit".into());
        }
        let read = || -> Result<Vec<u8>, String> {
            let canonical_root = root.canonicalize().map_err(io)?;
            if canonical_root != root || canonical_root.parent() != Some(self.root.as_path()) {
                return Err("Installed pack directory changed".into());
            }
            let file = root.join(&relative).canonicalize().map_err(io)?;
            if !file.starts_with(&root) {
                return Err("Content resource escaped its installed pack".into());
            }
            let mut bytes = Vec::new();
            File::open(file)
                .map_err(io)?
                .take(expected.size + 1)
                .read_to_end(&mut bytes)
                .map_err(io)?;
            if bytes.len() as u64 != expected.size
                || format!("{:x}", Sha256::digest(&bytes)) != expected.sha256
            {
                return Err("Installed content resource failed its checksum; request the pack again to repair it".into());
            }
            Ok(bytes)
        };
        match read() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) => {
                self.invalidate(name);
                Err(error)
            }
        }
    }
}

fn loopback(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
    )
}
struct RequestLease<'a>(&'a AtomicUsize);
impl Drop for RequestLease<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}
fn safe_url(url: &Url, allow_loopback: bool) -> bool {
    if url.as_str().len() > 16_384
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    if allow_loopback && loopback(url) {
        return matches!(url.scheme(), "http" | "https") && url.query().is_none();
    }
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && match url.host_str() {
            Some("github.com") => url
                .path()
                .starts_with("/somepoi/tarkov-companion-rust/releases/download/"),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => true,
            _ => false,
        }
}
fn write_new(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(file)
        .map_err(io)?;
    output.write_all(bytes).map_err(io)?;
    output.sync_all().map_err(io)
}
struct HashReader<R> {
    reader: R,
    hash: Sha256,
}
impl<R: Read> Read for HashReader<R> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.reader.read(bytes)?;
        self.hash.update(&bytes[..count]);
        Ok(count)
    }
}
fn unpack(
    name: &str,
    info: &PackInfo,
    archive: &Path,
    destination: &Path,
) -> Result<Marker, String> {
    let file = File::open(archive).map_err(io)?;
    if file.metadata().map_err(io)?.len() != info.size {
        return Err("Pack archive size changed".into());
    }
    let mut input = HashReader {
        reader: BufReader::new(file),
        hash: Sha256::new(),
    };
    let mut prefix = [0_u8; 10];
    input.read_exact(&mut prefix).map_err(io)?;
    if &prefix[..MAGIC.len()] != MAGIC {
        return Err("Not a TCPK1 content pack".into());
    }
    let length = u32::from_be_bytes(
        prefix[MAGIC.len()..]
            .try_into()
            .map_err(|_| "Invalid pack header")?,
    ) as usize;
    if length == 0 || length > MAX_HEADER || length as u64 + 10 > info.size {
        return Err("Content-pack header exceeds its budget".into());
    }
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes).map_err(io)?;
    let mut header: Header = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    validate_entries(name, info, length, &mut header.files)?;
    let root = destination.canonicalize().map_err(io)?;
    let mut files = BTreeMap::new();
    let mut buffer = [0_u8; 64 * 1024];
    for entry in header.files {
        let target = root.join(&entry.path);
        let parent = target.parent().ok_or("Pack entry has no parent")?;
        fs::create_dir_all(parent).map_err(io)?;
        if !parent.canonicalize().map_err(io)?.starts_with(&root) {
            return Err("Pack entry escaped its staging directory".into());
        }
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&target)
            .map_err(io)?;
        let mut remaining = entry.size;
        let mut hash = Sha256::new();
        while remaining > 0 {
            let count = remaining.min(buffer.len() as u64) as usize;
            input.read_exact(&mut buffer[..count]).map_err(io)?;
            output.write_all(&buffer[..count]).map_err(io)?;
            hash.update(&buffer[..count]);
            remaining -= count as u64;
        }
        output.sync_all().map_err(io)?;
        files.insert(
            entry.path,
            StoredFile {
                size: entry.size,
                sha256: format!("{:x}", hash.finalize()),
            },
        );
    }
    if input.read(&mut [0]).map_err(io)? != 0
        || format!("{:x}", input.hash.finalize()) != info.sha256
    {
        return Err("Pack archive changed or failed its checksum during extraction".into());
    }
    Ok(Marker {
        pack_sha256: info.sha256.clone(),
        files,
    })
}

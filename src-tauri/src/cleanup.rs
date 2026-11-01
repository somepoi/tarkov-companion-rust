//! Explicit, preview-bound recycling of fork leftovers. Never executes during startup.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

#[derive(Clone, Serialize)]
pub struct Item {
    label: String,
    bytes: u64,
}
#[derive(Clone, Serialize)]
pub struct Report {
    items: Vec<Item>,
    bytes: u64,
    dry: bool,
    at: u64,
    warnings: Vec<String>,
}
struct Candidate {
    path: PathBuf,
    root: PathBuf,
    digest: [u8; 32],
    item: Item,
    pack: bool,
}
struct Preview {
    created: Instant,
    candidates: Vec<Candidate>,
}
#[derive(Default)]
struct State {
    preview: Option<Preview>,
    last: Option<Report>,
}
#[derive(Default)]
pub struct Cleanup {
    state: Mutex<State>,
}

fn plain(path: &Path) -> Result<fs::Metadata, String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Reparse points are not cleanup targets".into());
        }
    }
    if meta.file_type().is_symlink() || !(meta.is_file() || meta.is_dir()) {
        return Err("Cleanup requires plain files/directories".into());
    }
    Ok(meta)
}

fn identity(path: &Path) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{
                BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
                FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
                FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
            },
        };
        let file = fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES.0)
            .share_mode((FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(path)
            .map_err(|e| e.to_string())?;
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
            .map_err(|e| e.to_string())?;
        if info.dwFileAttributes & 0x400 != 0
            || (info.dwFileAttributes & 0x10 == 0 && info.nNumberOfLinks != 1)
        {
            return Err("Linked files cannot be recycled by cleanup".into());
        }
        Ok([
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.ftCreationTime.dwHighDateTime,
            info.ftCreationTime.dwLowDateTime,
            info.ftLastWriteTime.dwHighDateTime,
            info.ftLastWriteTime.dwLowDateTime,
            info.nFileSizeHigh,
            info.nFileSizeLow,
            info.dwFileAttributes,
        ]
        .into_iter()
        .flat_map(u32::to_le_bytes)
        .collect())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("Cleanup is supported only on Windows".into())
    }
}

// Metadata/file identities, not content hashes. Bound discovery even for unexpected trees.
fn snapshot(root: &Path, path: &Path) -> Result<([u8; 32], u64), String> {
    if root.canonicalize().map_err(|e| e.to_string())? != root
        || plain(root)?.is_file()
        || path.parent() != Some(root)
        || path.canonicalize().map_err(|e| e.to_string())? != path
    {
        return Err("Cleanup scope changed".into());
    }
    fn walk(
        path: &Path,
        base: &Path,
        hash: &mut Sha256,
        bytes: &mut u64,
        count: &mut usize,
        start: Instant,
        depth: usize,
    ) -> Result<(), String> {
        *count += 1;
        if *count > 100_000 || depth > 32 || start.elapsed() > Duration::from_secs(10) {
            return Err("Cleanup inspection exceeded its budget".into());
        }
        let meta = plain(path)?;
        if path.canonicalize().map_err(|e| e.to_string())? != path {
            return Err("Cleanup path was redirected".into());
        }
        let name = path
            .strip_prefix(base)
            .map_err(|e| e.to_string())?
            .as_os_str()
            .as_encoded_bytes();
        hash.update((name.len() as u64).to_le_bytes());
        hash.update(name);
        hash.update(identity(path)?);
        if meta.is_file() {
            *bytes = bytes
                .checked_add(meta.len())
                .ok_or("Cleanup size overflow")?;
        } else {
            let mut children = Vec::new();
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                if children.len() >= 100_000 {
                    return Err("Cleanup directory exceeds its entry budget".into());
                }
                children.push(entry.map_err(|e| e.to_string())?.path());
            }
            children.sort();
            for child in children {
                walk(&child, base, hash, bytes, count, start, depth + 1)?;
            }
        }
        Ok(())
    }
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut count = 0;
    // Bind the resolved parent identity too; a replacement directory invalidates preview.
    let root_id = identity(root)?;
    hash.update(&root_id[..20]);
    walk(
        path,
        root,
        &mut hash,
        &mut bytes,
        &mut count,
        Instant::now(),
        0,
    )?;
    Ok((hash.finalize().into(), bytes))
}

fn old_installer(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let version = name
        .strip_prefix("tarkov companion rust_")
        .and_then(|s| s.strip_suffix("_x64-setup.exe"))
        .or_else(|| {
            name.strip_prefix("tarkovcompanionrust-setup-")
                .and_then(|s| {
                    s.strip_suffix(".exe.blockmap")
                        .or_else(|| s.strip_suffix(".exe"))
                })
        })
        .or_else(|| {
            name.strip_prefix("tarkovcompanionrust-")
                .and_then(|s| s.strip_suffix("-portable.exe"))
        });
    version
        .and_then(|s| semver::Version::parse(s).ok())
        .is_some_and(|v| {
            v.pre.is_empty()
                && v.build.is_empty()
                && v < semver::Version::parse(env!("CARGO_PKG_VERSION")).expect("package version")
        })
}

impl Cleanup {
    pub fn last(&self) -> Result<Option<Report>, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "Cleanup state unavailable")?
            .last
            .clone())
    }
    pub fn run(
        &self,
        app: &tauri::AppHandle,
        packs: &crate::packs::Packs,
        dry: bool,
    ) -> Result<Report, String> {
        if crate::desktop::benchmark_mode() {
            return Err("Cleanup is disabled during measurements".into());
        }
        let mut state = self
            .state
            .try_lock()
            .map_err(|_| "Cleanup is already running")?;
        packs.with_cleanup(|pack_paths| {
            let mut report = Report {
                items: Vec::new(),
                bytes: 0,
                dry,
                at: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                warnings: Vec::new(),
            };
            if dry {
                state.preview = None;
                let mut paths: Vec<_> = pack_paths
                    .into_iter()
                    .map(|p| ("Old content pack", p))
                    .collect();
                if let Ok(dir) = app.path().download_dir() {
                    match dir.canonicalize().and_then(fs::read_dir) {
                        Ok(entries) => {
                            for (index, entry) in entries.enumerate() {
                                if index >= 4096 {
                                    report.warnings.push(
                                        "Downloads inspection stopped after 4096 entries".into(),
                                    );
                                    break;
                                }
                                let entry = entry.map_err(|e| e.to_string())?;
                                if old_installer(&entry.file_name().to_string_lossy())
                                    && entry.file_type().map_err(|e| e.to_string())?.is_file()
                                {
                                    paths.push(("Old fork installer in Downloads", entry.path()));
                                }
                            }
                        }
                        Err(e) => report
                            .warnings
                            .push(format!("Downloads could not be inspected: {e}")),
                    }
                }
                if paths.len() > 128 {
                    return Err("Too many cleanup candidates; no cleanup was prepared".into());
                }
                let running = std::env::current_exe()
                    .ok()
                    .and_then(|p| p.canonicalize().ok());
                let mut candidates = Vec::new();
                let started = Instant::now();
                for (kind, path) in paths {
                    if started.elapsed() > Duration::from_secs(15) {
                        report.warnings.push(
                            "Inspection time budget reached; only the listed targets were prepared"
                                .into(),
                        );
                        break;
                    }
                    if running.as_ref() == Some(&path) {
                        continue;
                    }
                    let root = path
                        .parent()
                        .ok_or("Cleanup target has no parent")?
                        .to_owned();
                    match snapshot(&root, &path) {
                        Ok((digest, bytes)) => {
                            let item = Item {
                                label: format!(
                                    "{kind} (to Recycle Bin): {}",
                                    path.file_name().unwrap_or_default().to_string_lossy()
                                ),
                                bytes,
                            };
                            report.bytes += bytes;
                            report.items.push(item.clone());
                            candidates.push(Candidate {
                                path,
                                root,
                                digest,
                                item,
                                pack: kind == "Old content pack",
                            });
                        }
                        Err(e) => report.warnings.push(format!(
                            "Skipped {}: {e}",
                            path.file_name().unwrap_or_default().to_string_lossy()
                        )),
                    }
                }
                state.preview = Some(Preview {
                    created: Instant::now(),
                    candidates,
                });
            } else {
                let preview = state
                    .preview
                    .take()
                    .ok_or("Check what can go before confirming cleanup")?;
                if preview.created.elapsed() > Duration::from_secs(120) {
                    return Err("Cleanup preview expired; check again".into());
                }
                let started = Instant::now();
                for candidate in preview.candidates {
                    if started.elapsed() > Duration::from_secs(30) {
                        report.warnings.push("Cleanup time budget reached; remaining targets were retained. Check again to continue.".into());
                        break;
                    }
                    // Pack eligibility may change after preview, even if the bytes did not.
                    if candidate.pack && !pack_paths.contains(&candidate.path)
                    {
                        report
                            .warnings
                            .push(format!("Retained changed pack: {}", candidate.item.label));
                        continue;
                    }
                    let permitted = || {
                        snapshot(&candidate.root, &candidate.path)
                            .is_ok_and(|(digest, _)| digest == candidate.digest)
                    };
                    if !permitted() {
                        report
                            .warnings
                            .push(format!("Retained changed target: {}", candidate.item.label));
                        continue;
                    }
                    match crate::recycle::recycle(&candidate.path, permitted) {
                        Ok(()) if !candidate.path.exists() => {
                            report.bytes += candidate.item.bytes;
                            report.items.push(candidate.item);
                        }
                        Ok(()) => report.warnings.push(format!(
                            "Target remains after recycle request: {}",
                            candidate.item.label
                        )),
                        Err(e) => report
                            .warnings
                            .push(format!("Could not recycle {}: {e}", candidate.item.label)),
                    }
                }
                state.last = Some(report.clone());
            }
            Ok(report)
        })
    }
}

//! User-selected JSON/CSV exports. No renderer-supplied destination paths.
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri_plugin_dialog::DialogExt;

const LIMIT: usize = 20 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(0);
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Progress,
    InventoryJson,
    InventoryCsv,
}
impl Kind {
    fn extension(self) -> &'static str {
        if matches!(self, Self::InventoryCsv) {
            "csv"
        } else {
            "json"
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Selection {
    kind: Kind,
    name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteRequest {
    id: String,
    text: String,
}
struct Permit {
    id: String,
    path: PathBuf,
    kind: Kind,
    created: Instant,
    parent_identity: Vec<u8>,
    previous: Option<Vec<u8>>,
}
#[derive(Default)]
pub struct Exports {
    permit: Mutex<Option<Permit>>,
}

fn id() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )
}
fn file_state(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("Choose a regular export file, not a redirected path".into());
                }
            }
            if !meta.is_file() || meta.file_type().is_symlink() {
                return Err("Choose a regular export file".into());
            }
            crate::file_identity::identity(path).map(Some)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}
impl Exports {
    /// Called on a blocking worker; hold the state lock through the native picker.
    pub fn call(
        &self,
        app: &tauri::AppHandle,
        window: &tauri::WebviewWindow,
        profile: &std::path::Path,
        operation: &str,
        value: Value,
    ) -> Result<Value, String> {
        if window.label() != "main" {
            return Err("Only the main window can save exports".into());
        }
        if crate::desktop::benchmark_mode() {
            return Err("Export dialogs are disabled during measurements".into());
        }
        let mut permit = self
            .permit
            .try_lock()
            .map_err(|_| "Another export is already running")?;
        match operation {
            "export:select" => {
                let request: Selection =
                    serde_json::from_value(value).map_err(|e| e.to_string())?;
                if request.name.is_empty()
                    || request.name.len() > 180
                    || !request
                        .name
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
                    || !request
                        .name
                        .ends_with(&format!(".{}", request.kind.extension()))
                {
                    return Err("Invalid suggested export filename".into());
                }
                *permit = None;
                let selected = app
                    .dialog()
                    .file()
                    .set_parent(window)
                    .set_title("Save Tarkov Companion export")
                    .add_filter("Export", &[request.kind.extension()])
                    .set_file_name(request.name)
                    .blocking_save_file();
                let Some(selected) = selected else {
                    return Ok(Value::Null);
                };
                let path = selected.into_path().map_err(|e| e.to_string())?;
                let filename = path.file_name().ok_or("Export filename is missing")?;
                if filename
                    .to_string_lossy()
                    .chars()
                    .any(|c| c.is_control() || matches!(c, ':' | '/' | '\\'))
                {
                    return Err("Choose a plain export filename, not a file stream".into());
                }
                if !path.is_absolute()
                    || !path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case(request.kind.extension()))
                {
                    return Err("Choose the matching JSON or CSV file extension".into());
                }
                let parent = path
                    .parent()
                    .ok_or("Export file has no parent directory")?
                    .canonicalize()
                    .map_err(|e| e.to_string())?;
                if parent.starts_with(profile) {
                    return Err(
                        "Save exported reports outside the application's profile directory".into(),
                    );
                }
                let path = parent.join(filename);
                let previous = file_state(&path)?;
                let parent_identity = crate::file_identity::identity(&parent)?[..20].to_vec();
                let token = id();
                *permit = Some(Permit {
                    id: token.clone(),
                    path,
                    kind: request.kind,
                    created: Instant::now(),
                    previous,
                    parent_identity,
                });
                Ok(json!({"id":token}))
            }
            "export:cancel" => {
                let token = value
                    .as_str()
                    .filter(|s| s.len() <= 128)
                    .ok_or("Invalid export selection")?;
                if permit.as_ref().is_some_and(|p| p.id == token) {
                    *permit = None;
                }
                Ok(Value::Null)
            }
            "export:write" => {
                let request: WriteRequest =
                    serde_json::from_value(value).map_err(|e| e.to_string())?;
                if request.text.is_empty() || request.text.len() > LIMIT {
                    return Err("Export must be nonempty and at most 20 MiB".into());
                }
                let selected = permit
                    .as_ref()
                    .filter(|p| {
                        p.id == request.id && p.created.elapsed() <= Duration::from_secs(120)
                    })
                    .ok_or("Export selection expired; choose a destination again")?;
                match selected.kind {
                    Kind::Progress | Kind::InventoryJson => {
                        let data: Value =
                            serde_json::from_str(&request.text).map_err(|e| e.to_string())?;
                        let valid = if matches!(selected.kind, Kind::Progress) {
                            data["app"] == "tarkov-companion"
                                && data["version"] == 1
                                && data["profiles"].is_object()
                        } else {
                            data["format"] == "tarkov-companion-inventory-facts"
                                && data["version"] == 1
                                && data["inventory"].is_object()
                        };
                        if !valid {
                            return Err("Unexpected export document format".into());
                        }
                    }
                    Kind::InventoryCsv => {
                        if !request
                            .text
                            .trim_start_matches('\u{feff}')
                            .starts_with("\"record_type\",\"profile_id\",\"mode\",")
                        {
                            return Err("Unexpected inventory CSV header".into());
                        }
                    }
                }
                let selected = permit.take().ok_or("Export selection unavailable")?;
                let parent = selected
                    .path
                    .parent()
                    .ok_or("Export directory unavailable")?;
                if parent.canonicalize().map_err(|e| e.to_string())? != parent {
                    return Err("Export directory changed; choose it again".into());
                }
                let unchanged = || -> Result<(), String> {
                    if crate::file_identity::identity(parent)?[..20] != selected.parent_identity
                        || file_state(&selected.path)? != selected.previous
                    {
                        return Err("Export destination changed; choose it again".into());
                    }
                    Ok(())
                };
                unchanged()?;
                // create_new binds cleanup to a file this operation actually created.
                let temporary = parent.join(format!(".tc-export-{}.pending", id()));
                let mut file = fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&temporary)
                    .map_err(|e| e.to_string())?;
                let result = (|| -> Result<(), String> {
                    file.write_all(request.text.as_bytes())
                        .map_err(|e| e.to_string())?;
                    file.sync_all().map_err(|e| e.to_string())?;
                    drop(file);
                    if parent.canonicalize().map_err(|e| e.to_string())? != parent {
                        return Err("Export directory changed during saving".into());
                    }
                    unchanged()?;
                    fs::rename(&temporary, &selected.path).map_err(|e| e.to_string())
                })();
                if let Err(error) = result {
                    if parent.canonicalize().ok().as_deref() != Some(parent)
                        || crate::file_identity::identity(parent)
                            .ok()
                            .is_none_or(|id| id[..20] != selected.parent_identity)
                    {
                        return Err(format!(
                            "{error}; temporary export retained because its directory changed"
                        ));
                    }
                    let cleanup = fs::remove_file(&temporary);
                    return Err(if let Err(cleanup) = cleanup {
                        format!("{error}; temporary export could not be removed: {cleanup}")
                    } else {
                        error
                    });
                }
                Ok(json!(true))
            }
            _ => Err("Unknown export operation".into()),
        }
    }
}

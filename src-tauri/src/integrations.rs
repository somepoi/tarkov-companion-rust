//! Host-owned global capture shortcut and fork-scoped Windows autostart.
use crate::desktop::{HostState, benchmark_mode};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct Integrations {
    shortcut: Mutex<BTreeMap<String, Shortcut>>,
    capturing: AtomicBool,
    next_capture: AtomicU64,
    pending_capture: Mutex<Option<(u64, Vec<u8>)>>,
}

impl Integrations {
    pub fn apply(
        &self,
        app: &tauri::AppHandle,
        settings: &Value,
        profile_root: &std::path::Path,
    ) -> Result<(), String> {
        if benchmark_mode() {
            return Ok(());
        }
        let mut desired = BTreeMap::new();
        let mut fields = vec![("scan", "scanHotkey")];
        if settings["searchBar"] == true {
            fields.extend([
                ("show", "searchBarHotkey"),
                ("search", "searchBarSearchHotkey"),
                ("lock", "searchBarLockHotkey"),
                ("map", "searchBarMapHotkey"),
            ]);
        }
        for (name, field) in fields {
            let key = settings[field].as_str().ok_or("Shortcut must be text")?;
            if key.is_empty() {
                continue;
            }
            let key: Shortcut = key
                .parse()
                .map_err(|e| format!("Invalid {name} shortcut: {e}"))?;
            if desired.values().any(|old| *old == key) {
                return Err("Capture and searchbar shortcuts must be distinct".into());
            }
            desired.insert(name.to_owned(), key);
        }
        let mut guard = self
            .shortcut
            .lock()
            .map_err(|_| "Shortcut state is unavailable")?;
        let previous_autostart = crate::autostart::read()?;
        let desired_autostart = settings["startWithWindows"]
            .as_bool()
            .ok_or("Autostart must be true or false")?;
        let desired_autostart = if desired_autostart {
            Some(crate::autostart::command(profile_root)?)
        } else {
            None
        };
        let mut added = Vec::new();
        for key in desired
            .values()
            .filter(|key| !guard.values().any(|old| old == *key))
        {
            if let Err(cause) = register(app, *key) {
                let rollback: Vec<_> = added
                    .iter()
                    .filter_map(|key| app.global_shortcut().unregister(*key).err())
                    .collect();
                return Err(format!(
                    "Shortcut unavailable: {cause}; reservation rollback: {rollback:?}. Choose another combination."
                ));
            }
            added.push(*key);
        }
        if previous_autostart != desired_autostart
            && let Err(cause) = crate::autostart::write(desired_autostart.as_deref())
        {
            let keys: Vec<_> = added
                .iter()
                .filter_map(|key| app.global_shortcut().unregister(*key).err())
                .collect();
            let rollback = crate::autostart::write(previous_autostart.as_deref());
            return Err(format!(
                "{cause}; shortcut rollback: {keys:?}; autostart rollback: {rollback:?}"
            ));
        }
        let mut removed = Vec::new();
        for key in guard
            .values()
            .filter(|key| !desired.values().any(|next| next == *key))
        {
            if let Err(cause) = app.global_shortcut().unregister(*key) {
                let restored: Vec<_> = removed
                    .iter()
                    .filter_map(|key| register(app, *key).err())
                    .collect();
                let keys: Vec<_> = added
                    .iter()
                    .filter_map(|key| app.global_shortcut().unregister(*key).err())
                    .collect();
                let rollback = crate::autostart::write(previous_autostart.as_deref());
                return Err(format!(
                    "Could not release shortcut: {cause}; previous keys rollback: {restored:?}; replacement keys rollback: {keys:?}; autostart rollback: {rollback:?}"
                ));
            }
            removed.push(*key);
        }
        *guard = desired;
        Ok(())
    }
}

fn register(app: &tauri::AppHandle, key: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(key, |app, key, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let app = app.clone();
            let key = *key;
            tauri::async_runtime::spawn_blocking(move || {
                let Some(state) = app.try_state::<Arc<HostState>>() else {
                    return;
                };
                let action = state.integrations.shortcut.lock().ok().and_then(|keys| {
                    keys.iter()
                        .find(|(_, value)| **value == key)
                        .map(|(name, _)| name.clone())
                });
                if let Some(action) = action {
                    if action == "scan" {
                        capture(&app);
                    } else if let Err(message) = state.searchbar.hotkey(&app, &action) {
                        let _ = app.emit("searchbar-error", message);
                    }
                }
            });
        })
        .map_err(|e| e.to_string())
}

fn capture(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<Arc<HostState>>() else {
        return;
    };
    let state = Arc::clone(state.inner());
    if state.integrations.capturing.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = crate::capture::capture_screen_under_cursor().and_then(|bytes| {
            if bytes.len() > 64 * 1024 * 1024 {
                return Err("Capture exceeds 64 MiB; import a smaller screenshot".into());
            }
            let id = state
                .integrations
                .next_capture
                .fetch_add(1, Ordering::Relaxed);
            *state
                .integrations
                .pending_capture
                .lock()
                .map_err(|_| "Capture state is unavailable")? = Some((id, bytes));
            let expiry_state = Arc::clone(&state);
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                if let Ok(mut pending) = expiry_state.integrations.pending_capture.lock()
                    && pending.as_ref().is_some_and(|(current, _)| *current == id)
                {
                    *pending = None;
                }
            });
            if let Some(window) = app.get_webview_window("main") {
                window.show().map_err(|e| e.to_string())?;
                window.unminimize().map_err(|e| e.to_string())?;
                window.set_focus().map_err(|e| e.to_string())?;
                window
                    .emit("scan-capture-ready", id)
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        });
        if let Err(message) = result {
            if let Ok(mut pending) = state.integrations.pending_capture.lock() {
                *pending = None;
            }
            let _ = app.emit("scan-capture-error", message);
        }
        state.integrations.capturing.store(false, Ordering::Release);
    });
}

#[tauri::command]
pub fn pending_scan_capture_id(
    state: tauri::State<'_, Arc<HostState>>,
    window: tauri::WebviewWindow,
) -> Result<Option<u64>, String> {
    if window.label() != "main" {
        return Err("Capture requires the main window".into());
    }
    Ok(state
        .integrations
        .pending_capture
        .lock()
        .map_err(|_| "Capture state is unavailable")?
        .as_ref()
        .map(|(id, _)| *id))
}

#[tauri::command]
pub fn take_scan_capture(
    state: tauri::State<'_, Arc<HostState>>,
    window: tauri::WebviewWindow,
    id: u64,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" {
        return Err("Capture requires the main window".into());
    }
    let mut pending = state
        .integrations
        .pending_capture
        .lock()
        .map_err(|_| "Capture state is unavailable")?;
    if !pending.as_ref().is_some_and(|(current, _)| *current == id) {
        return Err("This capture was superseded by a newer screenshot".into());
    }
    let (_, bytes) = pending.take().ok_or("Capture is no longer available")?;
    Ok(tauri::ipc::Response::new(bytes))
}

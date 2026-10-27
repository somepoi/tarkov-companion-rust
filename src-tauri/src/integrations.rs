//! Host-owned global capture shortcut and fork-scoped Windows autostart.
use crate::desktop::{HostState, benchmark_mode};
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[derive(Default)]
pub struct Integrations {
    shortcut: Mutex<Option<Shortcut>>,
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
        let key = settings["scanHotkey"]
            .as_str()
            .ok_or("Capture shortcut must be text")?;
        let desired: Option<Shortcut> = if key.is_empty() {
            None
        } else {
            Some(
                key.parse()
                    .map_err(|e| format!("Invalid capture shortcut: {e}"))?,
            )
        };
        let mut guard = self
            .shortcut
            .lock()
            .map_err(|_| "Shortcut state is unavailable")?;
        let old = *guard;
        let changed = old != desired;
        let previous_autostart = crate::autostart::read()?;
        let desired_autostart = settings["startWithWindows"]
            .as_bool()
            .ok_or("Autostart must be true or false")?;
        let desired_autostart = if desired_autostart {
            Some(crate::autostart::command(profile_root)?)
        } else {
            None
        };
        // Reserve a replacement before releasing the current key. Conflicts
        // therefore keep the previously working shortcut available.
        if changed && let Some(shortcut) = desired {
            app.global_shortcut()
                .on_shortcut(shortcut, |app, _, event| {
                    if event.state() == ShortcutState::Pressed {
                        capture(app);
                    }
                })
                .map_err(|e| {
                    format!("Capture shortcut is unavailable: {e}. Choose a different combination.")
                })?;
        }
        let update_autostart = || -> Result<(), String> {
            if previous_autostart != desired_autostart {
                crate::autostart::write(desired_autostart.as_deref())?;
            }
            Ok(())
        };
        if let Err(error) = update_autostart() {
            if changed && let Some(shortcut) = desired {
                let _ = app.global_shortcut().unregister(shortcut);
            }
            let rollback = crate::autostart::write(previous_autostart.as_deref());
            return Err(format!("{error}; autostart rollback: {rollback:?}"));
        }
        if changed
            && let Some(shortcut) = old
            && let Err(error) = app.global_shortcut().unregister(shortcut)
        {
            if let Some(replacement) = desired {
                let _ = app.global_shortcut().unregister(replacement);
            }
            let rollback = crate::autostart::write(previous_autostart.as_deref());
            return Err(format!(
                "Could not release the previous shortcut: {error}; autostart rollback: {rollback:?}"
            ));
        }
        *guard = desired;
        Ok(())
    }
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

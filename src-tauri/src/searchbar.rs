//! An inert-until-enabled overlay. All commands run on the host's blocking IPC worker.
use serde_json::{Value, json};
use std::{
    path::Path,
    sync::{Arc, Mutex},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const LABEL: &str = "searchbar";
const GLASS: f64 = 48.0;
const MARGIN: f64 = 16.0;
const LIMIT: f64 = 16_384.0;

#[derive(Default, Clone)]
pub struct SearchBar {
    inner: Arc<Mutex<State>>,
}

struct State {
    enabled: bool,
    anchor: (f64, f64),
    size: (f64, f64),
    flip: (bool, bool),
    locked: bool,
    ready: bool,
    masked: bool,
    visible: bool,
}

impl Default for State {
    fn default() -> Self {
        Self {
            enabled: false,
            anchor: (0.0, 0.0),
            size: (GLASS, GLASS),
            flip: (false, false),
            locked: false,
            ready: false,
            masked: false,
            visible: true,
        }
    }
}

impl SearchBar {
    pub fn is_enabled(&self) -> bool {
        self.inner.lock().map(|s| s.enabled).unwrap_or(false)
    }

    pub fn apply(&self, app: &AppHandle, settings: &Value, data_dir: &Path) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|e| e.to_string())?;
        let enabled = settings
            .get("searchBar")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && !crate::desktop::benchmark_mode();
        if !enabled {
            if let Some(w) = app.get_webview_window(LABEL) {
                w.destroy().map_err(err)?;
            }
            *s = State::default();
            return Ok(());
        }
        if s.enabled && app.get_webview_window(LABEL).is_some() {
            return Ok(());
        }
        let monitor = app
            .primary_monitor()
            .map_err(err)?
            .ok_or("No monitor available for search bar")?;
        let area = monitor.work_area();
        let scale = monitor.scale_factor();
        let saved = settings.get("searchBarPos");
        let anchor = saved
            .and_then(|p| Some((p.get("x")?.as_f64()?, p.get("y")?.as_f64()?)))
            .filter(|(x, y)| {
                x.is_finite() && y.is_finite() && x.abs() <= 1_000_000.0 && y.abs() <= 1_000_000.0
            })
            .unwrap_or((
                area.position.x as f64 + MARGIN * scale,
                area.position.y as f64 + MARGIN * scale,
            ));
        *s = State {
            anchor,
            ..State::default()
        };
        let w = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html".into()))
            .title("Tarkov Companion Rust search")
            .data_directory(data_dir.join("webview"))
            .inner_size(GLASS, GLASS)
            .visible(false)
            .focused(false)
            .focusable(true)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .minimizable(false)
            .maximizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .on_navigation(crate::navigation::guard(app))
            .build()
            .map_err(err)?;
        // Until a bounded DOM mask arrives no input surface is exposed.
        if let Err(error) = place(app, &w, &mut s) {
            let _ = w.destroy();
            return Err(error);
        }
        s.enabled = true;
        let controller = self.clone();
        let handle = app.clone();
        w.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::ScaleFactorChanged { .. }) {
                let controller = controller.clone();
                let handle = handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = controller.refresh_geometry(&handle);
                });
            }
        });
        Ok(())
    }

    fn refresh_geometry(&self, app: &AppHandle) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|e| e.to_string())?;
        let Some(w) = app.get_webview_window(LABEL) else {
            return Ok(());
        };
        s.masked = false;
        hide_native(&w)?;
        place(app, &w, &mut s)?;
        w.emit("searchbar-geometry", ()).map_err(err)
    }

    pub fn command(&self, app: &AppHandle, channel: &str, args: &[Value]) -> Result<Value, String> {
        let mut s = self.inner.lock().map_err(|e| e.to_string())?;
        let w = app
            .get_webview_window(LABEL)
            .ok_or("Search bar is disabled")?;
        match channel {
            "searchbar:size" => {
                s.size = (
                    number(args.first(), 40.0, LIMIT)?,
                    number(args.get(1), 40.0, LIMIT)?,
                );
                place(app, &w, &mut s)?;
            }
            "searchbar:move" => {
                let monitor = nearest(app, s.anchor)?;
                let dx = number(args.first(), -10_000.0, 10_000.0)?;
                let dy = number(args.get(1), -10_000.0, 10_000.0)?;
                s.anchor.0 += dx * monitor.scale_factor();
                s.anchor.1 += dy * monitor.scale_factor();
                place(app, &w, &mut s)?;
            }
            "searchbar:moved" => {
                place(app, &w, &mut s)?;
                return Ok(anchor(&s));
            }
            "searchbar:home" => {
                let monitor = app
                    .primary_monitor()
                    .map_err(err)?
                    .ok_or("No primary monitor")?;
                let area = monitor.work_area();
                s.anchor = (
                    area.position.x as f64 + MARGIN * monitor.scale_factor(),
                    area.position.y as f64 + MARGIN * monitor.scale_factor(),
                );
                place(app, &w, &mut s)?;
                return Ok(anchor(&s));
            }
            "searchbar:corner" => {
                let corner = args
                    .first()
                    .and_then(Value::as_str)
                    .ok_or("Invalid corner")?;
                if !matches!(corner, "tl" | "tr" | "bl" | "br") {
                    return Err("Invalid corner".into());
                }
                let monitor = nearest(app, s.anchor)?;
                let a = monitor.work_area();
                let scale = monitor.scale_factor();
                let x = a.position.x as f64;
                let y = a.position.y as f64;
                s.anchor = (
                    if corner.ends_with('r') {
                        x + a.size.width as f64 - (MARGIN + GLASS) * scale
                    } else {
                        x + MARGIN * scale
                    },
                    if corner.starts_with('b') {
                        y + a.size.height as f64 - (MARGIN + GLASS) * scale
                    } else {
                        y + MARGIN * scale
                    },
                );
                place(app, &w, &mut s)?;
                return Ok(anchor(&s));
            }
            "searchbar:regions" => {
                let rects = rectangles(args.first())?;
                let scale = w.scale_factor().map_err(err)?;
                if let Err(error) = native_region(&w, &rects, scale) {
                    s.masked = false;
                    let _ = hide_native(&w);
                    let _ = app.emit("searchbar-error", &error);
                    return Err(error);
                }
                s.masked = true;
                show_if_ready(&w, &s)?;
            }
            "searchbar:ready" => {
                s.ready = true;
                emit_layout(&w, &s)?;
                w.emit("searchbar-locked", s.locked).map_err(err)?;
                show_if_ready(&w, &s)?;
            }
            // Forwarded hover events are unavailable in Tauri. The native region replaces this.
            "searchbar:passthrough" => {
                boolean(args.first())?;
            }
            "searchbar:lock" => {
                set_locked(&w, &mut s, boolean(args.first())?)?;
            }
            "searchbar:locked" => return Ok(json!(s.locked)),
            "searchbar:hide" => {
                s.visible = !s.visible;
                if s.visible {
                    show_if_ready(&w, &s)?;
                } else {
                    hide_native(&w)?;
                }
            }
            "searchbar:release" => {
                // SW_HIDE relinquishes activation; restoring uses SW_SHOWNOACTIVATE.
                // Changing WS_EX_NOACTIVATE alone does not blur an active webview.
                hide_native(&w)?;
                show_if_ready(&w, &s)?;
            }
            _ => return Err(format!("Unsupported search bar command: {channel}")),
        }
        Ok(Value::Null)
    }

    pub fn hotkey(&self, app: &AppHandle, action: &str) -> Result<(), String> {
        let mut s = self.inner.lock().map_err(|e| e.to_string())?;
        if !s.enabled {
            return Ok(());
        }
        let w = app
            .get_webview_window(LABEL)
            .ok_or("Search bar window is unavailable")?;
        place(app, &w, &mut s)?;
        match action {
            "show" => {
                s.visible = !s.visible;
                if s.visible {
                    show_if_ready(&w, &s)?;
                } else {
                    hide_native(&w)?;
                }
            }
            "lock" => {
                let locked = !s.locked;
                set_locked(&w, &mut s, locked)?;
            }
            "search" => {
                set_locked(&w, &mut s, false)?;
                s.visible = true;
                show_if_ready(&w, &s)?;
                if s.ready && s.masked {
                    focus_search(&w)?;
                }
                w.emit("searchbar-focus", ()).map_err(err)?;
            }
            "map" => {
                s.visible = true;
                show_if_ready(&w, &s)?;
                w.emit("searchbar-map", ()).map_err(err)?;
            }
            _ => return Err("Unknown search bar hotkey action".into()),
        }
        Ok(())
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn number(v: Option<&Value>, min: f64, max: f64) -> Result<f64, String> {
    v.and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n >= min && *n <= max)
        .ok_or_else(|| "Invalid search bar geometry".into())
}
fn boolean(v: Option<&Value>) -> Result<bool, String> {
    v.and_then(Value::as_bool)
        .ok_or_else(|| "Expected a boolean".into())
}
fn anchor(s: &State) -> Value {
    json!({"x": s.anchor.0.round() as i32, "y": s.anchor.1.round() as i32})
}
fn emit_layout(w: &WebviewWindow, s: &State) -> Result<(), String> {
    w.emit("searchbar-layout", json!({"left":s.flip.0,"up":s.flip.1}))
        .map_err(err)
}

fn nearest(app: &AppHandle, point: (f64, f64)) -> Result<tauri::Monitor, String> {
    app.available_monitors()
        .map_err(err)?
        .into_iter()
        .min_by(|a, b| {
            let distance = |m: &tauri::Monitor| {
                let a = m.work_area();
                let dx = point.0
                    - point.0.clamp(
                        a.position.x as f64,
                        a.position.x as f64 + a.size.width as f64,
                    );
                let dy = point.1
                    - point.1.clamp(
                        a.position.y as f64,
                        a.position.y as f64 + a.size.height as f64,
                    );
                dx * dx + dy * dy
            };
            distance(a).total_cmp(&distance(b))
        })
        .ok_or_else(|| "No monitor available for search bar".into())
}

fn place(app: &AppHandle, w: &WebviewWindow, s: &mut State) -> Result<(), String> {
    let monitor = nearest(app, s.anchor)?;
    let a = monitor.work_area();
    let scale = monitor.scale_factor();
    let (x, y) = (a.position.x as f64, a.position.y as f64);
    let (right, bottom) = (x + a.size.width as f64, y + a.size.height as f64);
    let glass = GLASS * scale;
    s.anchor.0 = s.anchor.0.clamp(x, (right - glass).max(x)).round();
    s.anchor.1 = s.anchor.1.clamp(y, (bottom - glass).max(y)).round();
    let width = (s.size.0 * scale)
        .round()
        .clamp(1.0, a.size.width.max(1) as f64) as u32;
    let height = (s.size.1 * scale)
        .round()
        .clamp(1.0, a.size.height.max(1) as f64) as u32;
    let flip = (
        s.anchor.0 + width as f64 > right,
        s.anchor.1 + height as f64 > bottom,
    );
    let pos = PhysicalPosition::new(
        if flip.0 {
            (s.anchor.0 + glass - width as f64).max(x)
        } else {
            s.anchor.0
        } as i32,
        if flip.1 {
            (s.anchor.1 + glass - height as f64).max(y)
        } else {
            s.anchor.1
        } as i32,
    );
    let size = PhysicalSize::new(width, height);
    if w.outer_position().map_err(err)? != pos {
        w.set_position(pos).map_err(err)?;
    }
    if w.inner_size().map_err(err)? != size {
        w.set_size(size).map_err(err)?;
    }
    if s.flip != flip {
        s.flip = flip;
        emit_layout(w, s)?;
    }
    Ok(())
}

fn set_locked(w: &WebviewWindow, s: &mut State, locked: bool) -> Result<(), String> {
    if s.locked == locked {
        return w.emit("searchbar-locked", locked).map_err(err);
    }
    w.set_ignore_cursor_events(locked).map_err(err)?;
    s.locked = locked;
    // Tao's style update reapplies its creation-time hidden visibility. Restore
    // our native, inactive visibility after the queued style mutation.
    show_if_ready(w, s)?;
    w.emit("searchbar-locked", locked).map_err(err)
}
fn show_if_ready(w: &WebviewWindow, s: &State) -> Result<(), String> {
    if s.ready && s.masked && s.visible {
        show_inactive(w)?;
    }
    Ok(())
}

type Rect = [f64; 4];
fn rectangles(value: Option<&Value>) -> Result<Vec<Rect>, String> {
    let array = value
        .and_then(Value::as_array)
        .ok_or("Expected search bar rectangles")?;
    if array.len() > 128 {
        return Err("Too many search bar rectangles".into());
    }
    array
        .iter()
        .map(|r| {
            Ok([
                number(r.get("x"), -LIMIT, LIMIT)?,
                number(r.get("y"), -LIMIT, LIMIT)?,
                number(r.get("width"), 0.0, LIMIT)?,
                number(r.get("height"), 0.0, LIMIT)?,
            ])
        })
        .collect()
}

// A main-thread roundtrip is used only by blocking commands, never by a UI event callback.
#[cfg(windows)]
fn native_region(w: &WebviewWindow, rects: &[Rect], scale: f64) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        CombineRgn, CreateRectRgn, DeleteObject, RGN_OR, SetWindowRgn,
    };
    let hwnd = w.hwnd().map_err(err)?.0 as usize;
    let bounds = w.inner_size().map_err(err)?;
    let rects = rects.to_vec();
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    w.run_on_main_thread(move || {
        let result = (|| {
            // SAFETY: All regions are owned locally until SetWindowRgn succeeds.
            unsafe {
                let union = CreateRectRgn(0, 0, 0, 0);
                if union.is_null() {
                    return Err("Could not allocate search bar input region".to_string());
                }
                for [x, y, width, height] in rects {
                    let left = (x * scale).floor().clamp(0.0, bounds.width as f64) as i32;
                    let top = (y * scale).floor().clamp(0.0, bounds.height as f64) as i32;
                    let right = ((x + width) * scale).ceil().clamp(0.0, bounds.width as f64) as i32;
                    let bottom = ((y + height) * scale)
                        .ceil()
                        .clamp(0.0, bounds.height as f64) as i32;
                    let piece = CreateRectRgn(left, top, right.max(left), bottom.max(top));
                    if piece.is_null() {
                        DeleteObject(union);
                        return Err("Could not allocate search bar input rectangle".into());
                    }
                    let combined = CombineRgn(union, union, piece, RGN_OR);
                    DeleteObject(piece);
                    if combined == 0 {
                        DeleteObject(union);
                        return Err("Could not combine search bar input region".into());
                    }
                }
                if SetWindowRgn(hwnd as _, union, 1) == 0 {
                    DeleteObject(union);
                    return Err("Could not apply search bar input region; overlay hidden".into());
                }
                // The OS now owns union. Do not delete or reuse it.
                Ok(())
            }
        })();
        let _ = tx.send(result);
    })
    .map_err(err)?;
    rx.recv().map_err(err)?
}

#[cfg(windows)]
fn hide_native(w: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};
    let hwnd = w.hwnd().map_err(err)?.0 as usize;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    w.run_on_main_thread(move || {
        // SAFETY: Only the overlay's own HWND is hidden; no other application is targeted.
        unsafe {
            ShowWindow(hwnd as _, SW_HIDE);
        }
        let _ = tx.send(());
    })
    .map_err(err)?;
    rx.recv().map_err(err)
}
#[cfg(not(windows))]
fn hide_native(w: &WebviewWindow) -> Result<(), String> {
    w.hide().map_err(err)
}

#[cfg(windows)]
fn show_inactive(w: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_SHOWNOACTIVATE, ShowWindow};
    let hwnd = w.hwnd().map_err(err)?.0 as usize;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    w.run_on_main_thread(move || {
        // SAFETY: Tauri owns this HWND; this call only shows it without activating it.
        unsafe {
            ShowWindow(hwnd as _, SW_SHOWNOACTIVATE);
        }
        let _ = tx.send(());
    })
    .map_err(err)?;
    rx.recv().map_err(err)
}

#[cfg(windows)]
fn focus_search(w: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    let hwnd = w.hwnd().map_err(err)?.0 as usize;
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    w.run_on_main_thread(move || {
        // SAFETY: Only our own overlay HWND is activated, at the user's explicit
        // search hotkey request. Windows retains its foreground permission rules.
        let focused = unsafe { SetForegroundWindow(hwnd as _) } != 0;
        let _ = tx.send(focused);
    })
    .map_err(err)?;
    if rx.recv().map_err(err)? {
        Ok(())
    } else {
        Err("Windows declined to focus the search bar".into())
    }
}

#[cfg(not(windows))]
fn focus_search(w: &WebviewWindow) -> Result<(), String> {
    w.set_focus().map_err(err)
}

#[cfg(not(windows))]
fn native_region(_w: &WebviewWindow, _rects: &[Rect], _scale: f64) -> Result<(), String> {
    Err("Safe search bar input regions are supported only on Windows".into())
}
#[cfg(not(windows))]
fn show_inactive(w: &WebviewWindow) -> Result<(), String> {
    w.set_focusable(false).map_err(err)?;
    let shown = w.show().map_err(err);
    w.set_focusable(true).map_err(err)?;
    shown
}

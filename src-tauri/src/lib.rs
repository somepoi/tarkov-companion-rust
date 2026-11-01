mod autostart;
mod backup;
mod capture;
mod desktop;
mod integrations;
mod inventory;
mod jobs;
mod log_locator;
mod logs;
mod navigation;
mod packs;
mod position;
mod resources;
mod searchbar;
#[cfg(feature = "staged-updates")]
mod staged_download;
mod updates;

use desktop::HostState;
use std::sync::Arc;
use tauri::{
    Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};

pub fn run() {
    tauri::Builder::default()
        .register_asynchronous_uri_scheme_protocol("tcres", resources::serve)
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            desktop::desktop_metadata,
            desktop::desktop_call,
            desktop::read_game_screenshot,
            desktop::read_pack_resource,
            desktop::capture_screen,
            desktop::archive_screenshot,
            desktop::read_archived_screenshot,
            inventory::inventory_call,
            backup::native_backup,
            updates::check_staged_update,
            updates::download_staged_update,
            updates::prepare_staged_update,
            updates::install_staged_update,
            integrations::take_scan_capture,
            integrations::pending_scan_capture_id
        ])
        .setup(|app| {
            updates::initialize(app.handle())?;
            app.handle()
                .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
            let mut state = HostState::open(app.handle())?;
            if state.startup_issues.is_empty()
                && let Err(message) =
                    state
                        .integrations
                        .apply(app.handle(), &state.settings()?, &state.profile_root)
            {
                state.startup_issues.push(message);
            }
            let state = Arc::new(state);
            let minimized = state
                .settings()?
                .get("startMinimized")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
                || std::env::args().any(|arg| arg == "--minimized")
                || desktop::benchmark_mode();
            let data_dir = state.data_dir.clone();
            app.manage(Arc::clone(&state));
            let window =
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .data_directory(data_dir.join("webview"))
                    .on_navigation(navigation::guard(app.handle()))
                    .build()?;
            if !minimized {
                window.show()?;
            }
            if state.startup_issues.is_empty() {
                let state = Arc::clone(&state);
                let handle = app.handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    if let Err(message) = state.apply_overlay_settings(&handle) {
                        state.report_overlay_error(&handle, message);
                    }
                });
            }

            let show = MenuItem::with_id(
                app,
                "show",
                "Open Tarkov Companion Rust",
                true,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let overlay_show = MenuItem::with_id(
                app,
                "overlay-show",
                "Show/hide searchbar",
                true,
                None::<&str>,
            )?;
            let overlay_lock = MenuItem::with_id(
                app,
                "overlay-lock",
                "Lock/unlock searchbar",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show, &overlay_show, &overlay_lock, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .tooltip("Tarkov Companion Rust")
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.unminimize();
                            let _ = w.set_focus();
                        }
                    }
                    "overlay-show" | "overlay-lock" => {
                        let handle = app.clone();
                        let action = if event.id.as_ref() == "overlay-show" {
                            "show"
                        } else {
                            "lock"
                        };
                        tauri::async_runtime::spawn_blocking(move || {
                            let state = handle.state::<Arc<HostState>>();
                            if state.searchbar.is_enabled()
                                && let Err(message) = state.searchbar.hotkey(&handle, action)
                            {
                                state.report_overlay_error(&handle, message);
                            }
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "searchbar"
            {
                api.prevent_close();
                let handle = window.app_handle().clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = handle.state::<Arc<HostState>>();
                    if let Err(message) = state.searchbar.command(&handle, "searchbar:hide", &[]) {
                        state.report_overlay_error(&handle, message);
                    }
                });
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event
                && window.label() == "main"
            {
                let minimize = window.state::<Arc<HostState>>().minimize_to_tray();
                if minimize {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not start Tarkov Companion Rust");
}

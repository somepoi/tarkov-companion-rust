//! Shared top-level navigation boundary for both trusted application windows.
use tauri::{AppHandle, Url};

pub fn guard(app: &AppHandle) -> impl Fn(&Url) -> bool + Send + 'static {
    // Match Tauri's custom-protocol build distinction, not debug/release flags:
    // embedded debug builds must not inherit access to the Vite origin.
    let dev = if tauri::is_dev() {
        app.config().build.dev_url.clone()
    } else {
        None
    };
    move |url| {
        if !url.username().is_empty() || url.password().is_some() {
            return false;
        }
        let embedded = (url.scheme() == "tauri"
            && url.host_str() == Some("localhost")
            && url.port().is_none())
            || (url.scheme() == "http"
                && url.host_str() == Some("tauri.localhost")
                && url.port_or_known_default() == Some(80));
        embedded
            || dev.as_ref().is_some_and(|origin| {
                matches!(origin.scheme(), "http" | "https") && url.origin() == origin.origin()
            })
    }
}

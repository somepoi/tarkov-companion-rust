//! Read-only fixed-source API bridge, shared by main and searchbar consumers.
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::{Semaphore, watch};

type ResultState = Option<Arc<Result<Value, String>>>;
type Flights = BTreeMap<String, watch::Receiver<ResultState>>;
static FLIGHTS: OnceLock<Mutex<Flights>> = OnceLock::new();
static REQUESTS: Semaphore = Semaphore::const_new(32);
static NETWORK: Semaphore = Semaphore::const_new(4);

fn flights() -> &'static Mutex<Flights> {
    FLIGHTS.get_or_init(Mutex::default)
}

/// A completed read is removed rather than becoming a second timestamped cache.
struct FlightCleanup(String);
impl Drop for FlightCleanup {
    fn drop(&mut self) {
        if let Ok(mut pending) = flights().lock() {
            pending.remove(&self.0);
        }
    }
}

fn allowed(path: &str) -> bool {
    if matches!(path, "/endpoints" | "/status") {
        return true;
    }
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() < 3 || !parts[0].is_empty() || !matches!(parts[1], "regular" | "pve") {
        return false;
    }
    if parts.len() == 3 {
        return matches!(
            parts[2],
            "tasks"
                | "tasks_en"
                | "items"
                | "items_en"
                | "traders"
                | "traders_en"
                | "maps"
                | "maps_en"
                | "hideout"
                | "hideout_en"
                | "crafts"
                | "crafts_en"
                | "barters"
                | "barters_en"
        );
    }
    parts.len() == 4
        && parts[2] == "prices"
        && !parts[3].is_empty()
        && parts[3].len() <= 128
        && parts[3]
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn subscribe(path: String) -> Result<watch::Receiver<ResultState>, String> {
    let mut pending = flights()
        .lock()
        .map_err(|_| "Catalog request state is unavailable")?;
    if let Some(receiver) = pending.get(&path) {
        return Ok(receiver.clone());
    }
    if pending.len() >= 16 {
        return Err("Catalog sync is busy; retry after current reads finish".into());
    }
    let lease = crate::jobs::enter().map_err(str::to_owned)?;
    let (sender, receiver) = watch::channel(None);
    pending.insert(path.clone(), receiver.clone());
    // The task owns admission through real completion, even if a webview leaves.
    tauri::async_runtime::spawn(async move {
        let _cleanup = FlightCleanup(path.clone());
        let deadline = Instant::now() + Duration::from_secs(90);
        let result = async {
            let permit = tokio::time::timeout(Duration::from_secs(90), NETWORK.acquire())
                .await
                .map_err(|_| {
                    "Catalog request timed out while waiting for a download slot".to_owned()
                })?
                .map_err(|_| "Catalog downloads are unavailable".to_owned())?;
            tauri::async_runtime::spawn_blocking(move || {
                let (_permit, _lease) = (permit, lease);
                let client = reqwest::blocking::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(Duration::from_secs(15))
                    .timeout(Duration::from_secs(90))
                    .build()
                    .map_err(|e| format!("Could not initialize catalog sync: {e}"))?;
                let limit = if path.ends_with("/items") { 32 } else { 16 } * 1024 * 1024;
                crate::catalog::download(&client, &path, limit, deadline)
            })
            .await
            .map_err(|e| format!("Catalog worker stopped: {e}"))?
        }
        .await;
        let _ = sender.send(Some(Arc::new(result)));
    });
    Ok(receiver)
}

#[tauri::command]
pub async fn fetch_catalog_document(
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Value, String> {
    if !matches!(window.label(), "main" | "searchbar") {
        return Err("Catalog reads require an application window".into());
    }
    read(path).await
}

pub(super) async fn read(path: String) -> Result<Value, String> {
    if path.len() > 256 || !allowed(&path) {
        return Err("Unsupported catalog route".into());
    }
    let _request = REQUESTS
        .try_acquire()
        .map_err(|_| "Too many catalog consumers; retry shortly".to_owned())?;
    let mut receiver = subscribe(path)?;
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result.as_ref().clone();
        }
        receiver
            .changed()
            .await
            .map_err(|_| "Catalog request stopped before returning a result".to_owned())?;
    }
}

//! Coalesce native adaptation as well as HTTP reads across both webviews.
use serde_json::Value;
use stash_core::GameMode;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Semaphore, watch};

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Items,
    Hideout,
    Maps,
}
type State = Option<Arc<Result<Value, String>>>;
static PENDING: OnceLock<Mutex<BTreeMap<String, watch::Receiver<State>>>> = OnceLock::new();
static CONSUMERS: Semaphore = Semaphore::const_new(16);
fn pending() -> &'static Mutex<BTreeMap<String, watch::Receiver<State>>> {
    PENDING.get_or_init(Mutex::default)
}
struct Cleanup(String);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if let Ok(mut jobs) = pending().lock() {
            jobs.remove(&self.0);
        }
    }
}
fn subscribe(kind: Kind, mode: GameMode) -> Result<watch::Receiver<State>, String> {
    let mode = match mode {
        GameMode::Regular => "regular",
        GameMode::Pve => "pve",
    };
    let endpoint = match kind {
        Kind::Items => "items",
        Kind::Hideout => "hideout",
        Kind::Maps => "maps",
    };
    let key = format!("{mode}/{endpoint}");
    let mut jobs = pending()
        .lock()
        .map_err(|_| "Catalog adapter state is unavailable")?;
    if let Some(receiver) = jobs.get(&key) {
        return Ok(receiver.clone());
    }
    let lease = crate::jobs::enter().map_err(str::to_owned)?;
    let (sender, receiver) = watch::channel(None);
    jobs.insert(key.clone(), receiver.clone());
    // Six possible keys bound real jobs, regardless of consumer navigation.
    tauri::async_runtime::spawn(async move {
        let _cleanup = Cleanup(key);
        let result = async {
            let base = tauri::async_runtime::spawn(crate::catalog_transport::read(format!(
                "/{mode}/{endpoint}"
            )));
            let english = crate::catalog_transport::read(format!("/{mode}/{endpoint}_en")).await;
            let base = base
                .await
                .map_err(|e| format!("Catalog adapter source stopped: {e}"))??;
            let english = english?;
            tauri::async_runtime::spawn_blocking(move || {
                let _lease = lease;
                match kind {
                    Kind::Maps => stash_core::catalog::maps::adapt(&base, &english),
                    Kind::Hideout => {
                        serde_json::to_value(stash_core::catalog::hideout::adapt(&base, &english)?)
                            .map_err(|e| e.to_string())
                    }
                    Kind::Items => {
                        let fetched = SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .map_err(|e| e.to_string())?
                            .as_millis();
                        stash_core::catalog::items::adapt(
                            &base,
                            &english,
                            mode,
                            u64::try_from(fetched).map_err(|e| e.to_string())?,
                        )
                    }
                }
            })
            .await
            .map_err(|e| format!("Catalog adapter stopped: {e}"))?
        }
        .await;
        let _ = sender.send(Some(Arc::new(result)));
    });
    Ok(receiver)
}
pub(super) async fn load(
    window: &tauri::WebviewWindow,
    kind: Kind,
    mode: GameMode,
) -> Result<Value, String> {
    if !matches!(window.label(), "main" | "searchbar") {
        return Err("Catalog adaptation requires an application window".into());
    }
    let _consumer = CONSUMERS
        .try_acquire()
        .map_err(|_| "Catalog adaptation is busy; retry shortly".to_owned())?;
    let mut receiver = subscribe(kind, mode)?;
    loop {
        if let Some(result) = receiver.borrow().clone() {
            return result.as_ref().clone();
        }
        receiver
            .changed()
            .await
            .map_err(|_| "Catalog adapter stopped before returning data".to_owned())?;
    }
}

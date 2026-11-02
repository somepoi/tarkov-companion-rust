//! Fixed-source, bounded recipe sync. Persisted query snapshots remain frontend
//! offline copies; this module owns native acquisition and wire normalization.
use reqwest::blocking::Client;
use serde_json::Value;
use stash_core::{
    GameMode,
    catalog::{RECIPE_PLANNING_SCHEMA, RecipeCatalog, RecipeKind, recipes},
};
use std::{
    io::Read,
    sync::atomic::{AtomicU8, Ordering},
    time::{Duration, Instant},
};

const MAX_DOCUMENT: u64 = 16 * 1024 * 1024;
static RUNNING: AtomicU8 = AtomicU8::new(0);
static HIDEOUT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

#[tauri::command]
pub async fn load_hideout_catalog(
    window: tauri::WebviewWindow,
    mode: GameMode,
) -> Result<Vec<stash_core::catalog::hideout::Station>, String> {
    if !matches!(window.label(), "main" | "searchbar") {
        return Err("Hideout reads require an application window".into());
    }
    let admission = HIDEOUT
        .try_acquire()
        .map_err(|_| "Hideout sync is busy; retry shortly".to_owned())?;
    let lease = crate::jobs::enter().map_err(str::to_owned)?;
    let mode = match mode {
        GameMode::Regular => "regular",
        GameMode::Pve => "pve",
    };
    let base =
        tauri::async_runtime::spawn(crate::catalog_transport::read(format!("/{mode}/hideout")));
    let english = crate::catalog_transport::read(format!("/{mode}/hideout_en")).await;
    let base = base
        .await
        .map_err(|e| format!("Hideout sync worker stopped: {e}"))??;
    let english = english?;
    tauri::async_runtime::spawn_blocking(move || {
        let (_admission, _lease) = (admission, lease);
        stash_core::catalog::hideout::adapt(&base, &english)
    })
    .await
    .map_err(|e| format!("Hideout adapter stopped: {e}"))?
}

struct Admission(u8);
impl Drop for Admission {
    fn drop(&mut self) {
        RUNNING.fetch_and(!self.0, Ordering::AcqRel);
    }
}

fn document(
    client: &Client,
    mode: &str,
    endpoint: &str,
    deadline: Instant,
) -> Result<Value, String> {
    download(
        client,
        &format!("/{mode}/{endpoint}"),
        MAX_DOCUMENT,
        deadline,
    )
}

pub(super) fn download(
    client: &Client,
    path: &str,
    limit: u64,
    deadline: Instant,
) -> Result<Value, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("Catalog request timed out".into());
    }
    let response = client
        .get(format!("https://json.tarkov.dev{path}"))
        .timeout(remaining)
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::CACHE_CONTROL, "no-cache")
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|e| format!("Could not load {path} catalog: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "{path} catalog returned HTTP {}; redirects are not followed",
            response.status()
        ));
    }
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(format!("{path} catalog exceeds {} MiB", limit / 1048576));
    }
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read {path} catalog: {e}"))?;
    if bytes.len() as u64 > limit {
        return Err(format!("{path} catalog exceeds {} MiB", limit / 1048576));
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid {path} catalog JSON: {e}"))
}

#[tauri::command]
pub async fn load_recipe_catalog(
    window: tauri::WebviewWindow,
    mode: GameMode,
) -> Result<RecipeCatalog, String> {
    if window.label() != "main" {
        return Err("Recipe sync requires the main application window".into());
    }
    let lease = crate::jobs::enter().map_err(str::to_owned)?;
    let bit = match mode {
        GameMode::Regular => 1,
        GameMode::Pve => 2,
    };
    RUNNING
        .try_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            (active & bit == 0).then_some(active | bit)
        })
        .map_err(|_| {
            "Recipe sync for this mode is already running; retry after it finishes".to_owned()
        })?;
    let admission = Admission(bit);
    tauri::async_runtime::spawn_blocking(move || {
        let (_admission, _lease) = (admission, lease);
        let deadline = Instant::now() + Duration::from_secs(90);
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(90))
            .build()
            .map_err(|e| format!("Could not initialize recipe sync: {e}"))?;
        let mode = match mode {
            GameMode::Regular => "regular",
            GameMode::Pve => "pve",
        };
        let crafts = recipes(
            &document(&client, mode, "crafts", deadline)?,
            RecipeKind::Craft,
        )?;
        let barters = recipes(
            &document(&client, mode, "barters", deadline)?,
            RecipeKind::Barter,
        )?;
        Ok(RecipeCatalog {
            planning_schema: RECIPE_PLANNING_SCHEMA,
            crafts,
            barters,
        })
    })
    .await
    .map_err(|e| format!("Recipe sync worker stopped: {e}"))?
}

//! Explicit updater staging. Production update/install channels stay disabled.
use serde_json::{Value, json};

#[cfg(feature = "staged-updates")]
static JOB: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(feature = "staged-updates")]
static CANDIDATE: std::sync::Mutex<Option<crate::staged_download::Candidate>> =
    std::sync::Mutex::new(None);

#[cfg(feature = "staged-updates")]
fn configuration() -> Result<Option<(tauri::Url, String)>, String> {
    let endpoint = option_env!("TC_STAGED_UPDATE_ENDPOINT")
        .unwrap_or("")
        .trim();
    let key = option_env!("TC_STAGED_UPDATE_PUBLIC_KEY")
        .unwrap_or("")
        .trim();
    if endpoint.is_empty() && key.is_empty() {
        return Ok(None);
    }
    if endpoint.len() > 2048 || key.len() > 8192 || key.len() < 32 {
        return Err(
            "Updater staging requires a bounded HTTPS endpoint and public-key content".into(),
        );
    }
    use base64::Engine;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(key)
        .map_err(|_| "Staging key must be base64-encoded Tauri public-key content")?;
    let decoded = std::str::from_utf8(&decoded).map_err(|_| "Invalid public-key text")?;
    if decoded.lines().count() != 2 {
        return Err("Staging configuration accepts only a two-line minisign public key".into());
    }
    minisign_verify::PublicKey::decode(decoded).map_err(|_| "Invalid minisign public key")?;
    let url = tauri::Url::parse(endpoint).map_err(|_| "Invalid staging endpoint")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.host(), Some(url::Host::Domain(host)) if host.contains('.') && !host.ends_with(".localhost"))
    {
        return Err(
            "Staging endpoint must be public HTTPS without credentials, query or fragment".into(),
        );
    }
    // No upstream GitHub fallback or accidental original-project channel.
    let github = match url.host_str() {
        Some("github.com") => Some("/somepoi/tarkov-companion-rust/releases/"),
        Some("raw.githubusercontent.com") => Some("/somepoi/tarkov-companion-rust/"),
        _ => None,
    };
    if github.is_some_and(|prefix| !url.path().starts_with(prefix)) {
        return Err("GitHub staging updates must belong to the fork repository".into());
    }
    Ok(Some((url, key.to_owned())))
}

pub fn initialize(_app: &tauri::AppHandle) -> tauri::Result<()> {
    #[cfg(feature = "staged-updates")]
    if let Ok(Some((_, key))) = configuration() {
        _app.plugin(tauri_plugin_updater::Builder::new().pubkey(key).build())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn check_staged_update(
    _app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("Updater staging requires the main window".into());
    }
    if crate::desktop::benchmark_mode() {
        return Ok(
            json!({"state":"disabled","message":"Updater staging is disabled in benchmark mode"}),
        );
    }
    #[cfg(not(feature = "staged-updates"))]
    return Ok(json!({"state":"disabled","message":"This build does not include updater staging"}));
    #[cfg(feature = "staged-updates")]
    {
        use tauri_plugin_updater::UpdaterExt;
        let _job = JOB
            .try_lock()
            .map_err(|_| "An update check is already running")?;
        *CANDIDATE
            .lock()
            .map_err(|_| "Update state is unavailable")? = None;
        let Some((endpoint, key)) = configuration()? else {
            return Ok(
                json!({"state":"disabled","message":"No fork staging endpoint/public key was compiled into this build"}),
            );
        };
        let update = _app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .pubkey(key)
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?;
        Ok(match update {
            Some(update) => {
                let candidate = crate::staged_download::Candidate::new(
                    update.version,
                    update.download_url,
                    update.signature,
                )?;
                let result = json!({"state":"candidate","id":candidate.id,"version":candidate.version,"signatureVerified":false,"installable":false});
                *CANDIDATE
                    .lock()
                    .map_err(|_| "Update state is unavailable")? = Some(candidate);
                result
            }
            None => json!({"state":"none"}),
        })
    }
}

#[tauri::command]
pub async fn download_staged_update(
    _state: tauri::State<'_, std::sync::Arc<crate::desktop::HostState>>,
    window: tauri::WebviewWindow,
    id: String,
) -> Result<Value, String> {
    if window.label() != "main" || crate::desktop::benchmark_mode() {
        return Err("Update downloads require the main window outside benchmark mode".into());
    }
    let _ = &id;
    #[cfg(not(feature = "staged-updates"))]
    return Err("Updater staging is not included in this build".into());
    #[cfg(feature = "staged-updates")]
    {
        let lease = crate::jobs::enter().map_err(str::to_owned)?;
        let _job = JOB
            .try_lock()
            .map_err(|_| "An update operation is already running")?;
        let candidate = CANDIDATE
            .lock()
            .map_err(|_| "Update state is unavailable")?
            .clone()
            .filter(|candidate| candidate.id == id && candidate.fresh())
            .ok_or("Update candidate expired or changed; check the channel again")?;
        let (_, key) = configuration()?.ok_or("Staging channel is not configured")?;
        let root = _state.profile_root.join("updater-staging");
        tauri::async_runtime::spawn_blocking(move || {
            // Keep serialization with the actual IO even if the caller goes away.
            let _job = _job;
            let _lease = lease;
            crate::staged_download::download(candidate, key, root)
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Capture a recovery point under exclusive IO admission. This never installs.
#[tauri::command]
pub async fn prepare_staged_update(
    _state: tauri::State<'_, std::sync::Arc<crate::desktop::HostState>>,
    window: tauri::WebviewWindow,
    id: String,
    renderer_state: Value,
    saved_drafts: bool,
) -> Result<Value, String> {
    if window.label() != "main" || crate::desktop::benchmark_mode() || !saved_drafts {
        return Err(
            "Save open drafts and prepare from the main window outside benchmark mode".into(),
        );
    }
    let _ = (&id, &renderer_state);
    #[cfg(not(feature = "staged-updates"))]
    return Err("Updater staging is not included in this build".into());
    #[cfg(feature = "staged-updates")]
    {
        if renderer_state.to_string().len() > 20 * 1024 * 1024 {
            return Err("Recovery state exceeds 20 MiB".into());
        }
        let job = JOB
            .try_lock()
            .map_err(|_| "An update operation is already running")?;
        let valid = CANDIDATE
            .lock()
            .map_err(|_| "Update state is unavailable")?
            .as_ref()
            .is_some_and(|candidate| candidate.id == id && candidate.fresh());
        if !valid {
            return Err("Update candidate expired or changed; check the channel again".into());
        }
        let exclusive = crate::jobs::exclusive().map_err(str::to_owned)?;
        let state = std::sync::Arc::clone(_state.inner());
        tauri::async_runtime::spawn_blocking(move || {
            let _job = job;
            let _exclusive = exclusive;
            let backup = crate::backup::recovery_copy(&state, renderer_state, window)?;
            Ok(json!({"state":"prepared","backup":backup,"installable":false}))
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

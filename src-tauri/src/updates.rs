//! Explicit updater staging. Production update/install channels stay disabled.
use serde_json::{Value, json};

#[cfg(feature = "staged-updates")]
static JOB: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
#[cfg(feature = "staged-updates")]
static CANDIDATE: std::sync::Mutex<Option<crate::staged_download::Candidate>> =
    std::sync::Mutex::new(None);

#[cfg(feature = "staged-updates")]
fn public_https(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && matches!(url.host(), Some(url::Host::Domain(host)) if host.contains('.') && !host.ends_with('.') && !host.ends_with(".localhost"))
}

#[cfg(feature = "staged-updates")]
fn fork_path(url: &tauri::Url) -> bool {
    let prefix = match url.host_str() {
        Some("github.com") => "/somepoi/tarkov-companion-rust/releases/",
        Some("raw.githubusercontent.com") => "/somepoi/tarkov-companion-rust/",
        _ => return true,
    };
    url.path().starts_with(prefix)
}

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
    if !public_https(&url) || url.query().is_some() {
        return Err(
            "Staging endpoint must be public HTTPS without credentials, query or fragment".into(),
        );
    }
    // No upstream GitHub fallback or accidental original-project channel.
    if !fork_path(&url) {
        return Err("GitHub staging updates must belong to the fork repository".into());
    }
    if endpoint.contains("{{") || endpoint.to_ascii_lowercase().contains("%7b%7b") {
        return Err("Use a static staging manifest URL without template variables".into());
    }
    Ok(Some((url, key.to_owned())))
}

#[cfg(feature = "staged-updates")]
async fn read_manifest(endpoint: tauri::Url) -> Result<Option<Value>, String> {
    use crate::update_signature::MAX_MANIFEST_BYTES;
    use reqwest::{StatusCode, header, redirect::Policy};
    use std::time::Duration;

    let origin = endpoint.origin();
    let github_release = endpoint.host_str() == Some("github.com");
    let client = reqwest::Client::builder()
        .https_only(true)
        .no_gzip()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent("TarkovCompanionRust/staged-update")
        .redirect(Policy::custom(move |attempt| {
            let target = attempt.url();
            let same_origin = target.origin() == origin && fork_path(target);
            let release_cdn = github_release
                && target.port().is_none()
                && matches!(
                    target.host_str(),
                    Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com")
                );
            if attempt.previous().len() > 4
                || !public_https(target)
                || !(same_origin || release_cdn)
            {
                attempt.error("Update manifest redirect is outside the staging channel")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "Could not initialize update manifest transport")?;
    let mut response = client
        .get(endpoint)
        .header(header::ACCEPT, "application/json")
        .header(header::ACCEPT_ENCODING, "identity")
        .send()
        .await
        .map_err(|error| {
            if error.is_redirect() {
                "Update manifest redirect was refused"
            } else {
                "Could not download the update manifest"
            }
        })?;
    if response.status() == StatusCode::NO_CONTENT {
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(format!(
            "Update manifest server returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let too_large = "Update manifest exceeds the 512 KiB limit";
    if response
        .content_length()
        .is_some_and(|size| size > MAX_MANIFEST_BYTES as u64)
    {
        return Err(too_large.into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Update manifest transfer was interrupted")?
    {
        if chunk.len() > MAX_MANIFEST_BYTES - bytes.len() {
            return Err(too_large.into());
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Update manifest is not valid JSON".into())
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
        let Some(manifest) = read_manifest(endpoint.clone()).await? else {
            return Ok(json!({"state":"none"}));
        };
        let update = _app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|e| e.to_string())?
            .pubkey(key)
            .build()
            .map_err(|e| e.to_string())?
            .restore_update(manifest)
            .map_err(|e| e.to_string())?;
        Ok(match update {
            Some(update) => {
                let candidate = crate::staged_download::Candidate::new(update)?;
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

pub(crate) fn installation_enabled() -> bool {
    cfg!(all(windows, feature = "staged-updates"))
        && option_env!("TC_STAGED_INSTALL_ENABLED") == Some("1")
}

#[tauri::command]
pub async fn install_staged_update(
    _state: tauri::State<'_, std::sync::Arc<crate::desktop::HostState>>,
    window: tauri::WebviewWindow,
    id: String,
    sha256: String,
    version: String,
    renderer_state: Value,
    saved_drafts: bool,
) -> Result<Value, String> {
    if !installation_enabled() {
        return Err("Installer execution is disabled in this build".into());
    }
    if window.label() != "main" || crate::desktop::benchmark_mode() || !saved_drafts {
        return Err(
            "Save open drafts and install only from the main window outside benchmark mode".into(),
        );
    }
    let _ = (&id, &sha256, &version, &renderer_state);
    #[cfg(not(feature = "staged-updates"))]
    return Err("Updater staging is not included".into());
    #[cfg(feature = "staged-updates")]
    {
        if renderer_state.to_string().len() > 20 * 1024 * 1024 {
            return Err("Recovery state exceeds 20 MiB".into());
        }
        let job = JOB
            .try_lock()
            .map_err(|_| "An update operation is already running")?;
        let candidate = CANDIDATE
            .lock()
            .map_err(|_| "Update state is unavailable")?
            .clone()
            .filter(|candidate| {
                candidate.id == id && candidate.version == version && candidate.fresh()
            })
            .ok_or("Update candidate expired or changed; check the channel again")?;
        let (_, key) = configuration()?.ok_or("Staging channel is not configured")?;
        let exclusive = crate::jobs::exclusive().map_err(str::to_owned)?;
        let state = std::sync::Arc::clone(_state.inner());
        tauri::async_runtime::spawn_blocking(move || {
            let _job = job;
            let _exclusive = exclusive;
            let bytes = crate::staged_download::read_verified(
                &candidate,
                &key,
                &state.profile_root.join("updater-staging"),
                &sha256,
            )?;
            let backup = crate::backup::recovery_copy(&state, renderer_state, window)?;
            let receipt =
                json!({"version":candidate.version,"backup":backup["name"],"sha256":sha256});
            crate::desktop::atomic_write(
                &state.profile_root.join("pending-staged-update.json"),
                &serde_json::to_vec(&receipt).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            candidate.update.install(&bytes).map_err(|e| {
                format!(
                    "Installer did not start: {e}. Recovery copy retained at {}",
                    backup["path"]
                )
            })?;
            Ok(json!({"state":"installing"}))
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

/// Main-window startup consumes a bounded receipt once; it never runs an installer.
pub(crate) fn outcome(state: &crate::desktop::HostState) -> Result<Value, String> {
    use std::io::Read;
    static OUTCOME: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);
    let mut cached = OUTCOME
        .lock()
        .map_err(|_| "Update outcome state unavailable")?;
    if let Some(value) = cached.as_ref() {
        return Ok(value.clone());
    }
    let path = state.profile_root.join("pending-staged-update.json");
    let mut input = match std::fs::File::open(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            *cached = Some(Value::Null);
            return Ok(Value::Null);
        }
        result => result.map_err(|e| e.to_string())?,
    };
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 {
        return Err("Update outcome receipt is too large".into());
    }
    let receipt: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid update outcome receipt")?;
    let version = receipt["version"]
        .as_str()
        .filter(|v| v.len() <= 128)
        .ok_or("Missing update version")?;
    let expected = semver::Version::parse(version.trim_start_matches('v'))
        .map_err(|_| "Invalid update version")?;
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    let backup = receipt["backup"]
        .as_str()
        .filter(|v| {
            v.strip_prefix("backup-").is_some_and(|suffix| {
                !suffix.is_empty()
                    && suffix.len() <= 80
                    && suffix.bytes().all(|b| b.is_ascii_digit() || b == b'-')
            })
        })
        .ok_or("Invalid recovery copy name")?;
    drop(input);
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::fs::rename(
        path,
        state
            .profile_root
            .join(format!("staged-update-outcome-{at}.json")),
    )
    .map_err(|e| e.to_string())?;
    let value = json!({"ok":current >= expected,"version":version,"recoveryBackup":state.profile_root.join("full-backups").join(backup)});
    *cached = Some(value.clone());
    Ok(value)
}

//! Bounded signed staging payloads. Nothing in this module executes installers.
use crate::update_signature::MAX_UPDATE_BYTES as MAX_BYTES;
use serde_json::{Value, json};
use std::{
    io::Read,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct Candidate {
    pub id: String,
    pub version: String,
    url: tauri::Url,
    signature: String,
    discovered: Instant,
    pub update: tauri_plugin_updater::Update,
}
fn permitted(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host(), Some(url::Host::Domain(host)) if host.contains('.') && !host.ends_with(".localhost"))
}
impl Candidate {
    pub fn new(update: tauri_plugin_updater::Update) -> Result<Self, String> {
        let version = update.version.clone();
        let url = update.download_url.clone();
        let signature = update.signature.clone();
        if version.len() > 128 || signature.len() > 16 * 1024 || !permitted(&url) {
            return Err("Invalid staging candidate metadata".into());
        }
        Ok(Self {
            id: format!("candidate-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
            version,
            url,
            signature,
            discovered: Instant::now(),
            update,
        })
    }
    pub fn fresh(&self) -> bool {
        self.discovered.elapsed() < Duration::from_secs(600)
    }
}

pub fn download(candidate: Candidate, key: String, root: PathBuf) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !permitted(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "Could not initialize update transport")?;
    let mut response = client
        .get(candidate.url.clone())
        .send()
        .map_err(|_| "Staging download failed")?
        .error_for_status()
        .map_err(|_| "Staging server rejected the download")?;
    if response.status().is_redirection() {
        return Err("Unsafe or excessive update redirect".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_BYTES as u64)
    {
        return Err("Update exceeds the 512-MiB staging limit".into());
    }
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let remaining = MAX_BYTES - bytes.len();
        let capacity = (remaining + 1).min(buffer.len());
        let n = response
            .read(&mut buffer[..capacity])
            .map_err(|_| "Update download was interrupted")?;
        if n == 0 {
            break;
        }
        if n > remaining {
            return Err("Update exceeds the 512-MiB staging limit".into());
        }
        bytes
            .try_reserve(n)
            .map_err(|_| "Not enough memory to verify this update")?;
        bytes.extend_from_slice(&buffer[..n]);
    }
    if bytes.is_empty() {
        return Err("Update payload is empty".into());
    }
    let digest = verify_payload(&bytes, &candidate, &key)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.join(format!("{digest}.verified-update"));
    crate::desktop::atomic_write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(
        json!({"state":"verified","id":candidate.id,"version":candidate.version,"bytes":bytes.len(),"sha256":digest,"path":path,"signatureVerified":true,"installable":false,"installEnabled":crate::updates::installation_enabled()}),
    )
}

fn verify_payload(bytes: &[u8], candidate: &Candidate, key: &str) -> Result<String, String> {
    crate::update_signature::verify_update(bytes, key, &candidate.signature, &candidate.version)
}

pub fn read_verified(
    candidate: &Candidate,
    key: &str,
    root: &std::path::Path,
    digest: &str,
) -> Result<Vec<u8>, String> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid staged payload checksum".into());
    }
    let path = root.join(format!("{digest}.verified-update"));
    let metadata = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES as u64 {
        return Err("Staged payload must be a bounded regular file".into());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("Staged payload escapes its directory".into());
    }
    let mut input = std::fs::File::open(canonical).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let remaining = MAX_BYTES - bytes.len();
        let capacity = (remaining + 1).min(buffer.len());
        let n = input
            .read(&mut buffer[..capacity])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if n > remaining {
            return Err("Staged payload grew beyond its size budget".into());
        }
        bytes
            .try_reserve(n)
            .map_err(|_| "Not enough memory to verify this update")?;
        bytes.extend_from_slice(&buffer[..n]);
    }
    if verify_payload(&bytes, candidate, key)? != digest {
        return Err("Staged payload checksum changed".into());
    }
    Ok(bytes)
}

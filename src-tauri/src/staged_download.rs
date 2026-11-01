//! Bounded signed staging payloads. Nothing in this module executes installers.
use base64::Engine;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
const MAX_BYTES: usize = 512 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub struct Candidate {
    pub id: String,
    pub version: String,
    url: tauri::Url,
    signature: String,
    discovered: Instant,
}
fn permitted(url: &tauri::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host(), Some(url::Host::Domain(host)) if host.contains('.') && !host.ends_with(".localhost"))
}
impl Candidate {
    pub fn new(version: String, url: tauri::Url, signature: String) -> Result<Self, String> {
        if version.len() > 128 || signature.len() > 16 * 1024 || !permitted(&url) {
            return Err("Invalid staging candidate metadata".into());
        }
        Ok(Self {
            id: format!("candidate-{}", NEXT.fetch_add(1, Ordering::Relaxed)),
            version,
            url,
            signature,
            discovered: Instant::now(),
        })
    }
    pub fn fresh(&self) -> bool {
        self.discovered.elapsed() < Duration::from_secs(600)
    }
}
fn signed_text(value: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| "Invalid signature encoding")?;
    String::from_utf8(bytes).map_err(|_| "Invalid signature text".into())
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
        .get(candidate.url)
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
    let public = minisign_verify::PublicKey::decode(&signed_text(&key)?)
        .map_err(|_| "Invalid staging public key")?;
    let signature = minisign_verify::Signature::decode(&signed_text(&candidate.signature)?)
        .map_err(|_| "Invalid update signature")?;
    public
        .verify(&bytes, &signature, true)
        .map_err(|_| "Update signature verification failed")?;
    // Read version metadata only after verification of both Minisign signatures.
    let versions = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|part| part.strip_prefix("version:"))
        .collect::<Vec<_>>();
    if versions.len() != 1
        || versions[0].trim_start_matches('v') != candidate.version.trim_start_matches('v')
    {
        return Err(
            "Signed artifact version is missing or differs from the announced version".into(),
        );
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let path = root.join(format!("{digest}.verified-update"));
    crate::desktop::atomic_write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(
        json!({"state":"verified","id":candidate.id,"version":candidate.version,"bytes":bytes.len(),"sha256":digest,"path":path,"signatureVerified":true,"installable":false}),
    )
}

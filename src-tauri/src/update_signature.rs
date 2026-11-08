//! Shared verification for native staging and offline release preparation.
use base64::Engine;
use sha2::{Digest, Sha256};
pub const MAX_UPDATE_BYTES: usize = 512 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: usize = 512 * 1024;

fn signed_text(value: &str) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value)
        .map_err(|_| "Invalid signature encoding")?;
    String::from_utf8(bytes).map_err(|_| "Invalid signature text".into())
}

pub fn verify_update(
    bytes: &[u8],
    key: &str,
    signature: &str,
    version: &str,
) -> Result<String, String> {
    if bytes.is_empty()
        || bytes.len() > MAX_UPDATE_BYTES
        || key.len() > 8192
        || signature.len() > 16 * 1024
        || version.len() > 128
    {
        return Err("Update or signature metadata exceeds its budget".into());
    }
    let key_text = signed_text(key)?;
    if key_text.lines().count() != 2 {
        return Err("Invalid public-key text".into());
    }
    let public =
        minisign_verify::PublicKey::decode(&key_text).map_err(|_| "Invalid staging public key")?;
    let signature = minisign_verify::Signature::decode(&signed_text(signature)?)
        .map_err(|_| "Invalid update signature")?;
    public
        .verify(bytes, &signature, true)
        .map_err(|_| "Update signature verification failed")?;
    // Read version metadata only after verification of both Minisign signatures.
    let versions = signature
        .trusted_comment()
        .split('\t')
        .filter_map(|part| part.strip_prefix("version:"))
        .collect::<Vec<_>>();
    if versions.len() != 1 || versions[0].trim_start_matches('v') != version.trim_start_matches('v')
    {
        return Err(
            "Signed artifact version is missing or differs from the announced version".into(),
        );
    }
    let digest = format!("{:x}", Sha256::digest(bytes));
    Ok(digest)
}

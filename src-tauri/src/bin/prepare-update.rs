//! Offline packaging tool. Never downloads, signs, publishes or runs an installer.
#[path = "../update_signature.rs"]
mod update_signature;
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

fn bounded(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    if !fs::symlink_metadata(path)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Release input must be a regular file".into());
    }
    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
    if input.metadata().map_err(|e| e.to_string())?.len() > limit as u64 {
        return Err("Release input exceeds its size limit".into());
    }
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let remaining = limit - bytes.len();
        let capacity = (remaining + 1).min(buffer.len());
        let n = input
            .read(&mut buffer[..capacity])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if n > remaining {
            return Err("Release input grew beyond its size limit".into());
        }
        bytes
            .try_reserve(n)
            .map_err(|_| "Not enough memory to prepare this update")?;
        bytes.extend_from_slice(&buffer[..n]);
    }
    Ok(bytes)
}
fn text(path: &Path, limit: usize) -> Result<String, String> {
    String::from_utf8(bounded(path, limit)?).map_err(|_| "Release text must be UTF-8".into())
}
fn write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    output
        .write_all(bytes)
        .and_then(|()| output.sync_all())
        .map_err(|e| e.to_string())
}
fn available(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}
fn run() -> Result<(), String> {
    let mut options = BTreeMap::new();
    let mut args = std::env::args_os().skip(1);
    while let Some(key) = args.next() {
        let key = key.to_str().ok_or("Invalid argument name")?.to_owned();
        if !["--artifact", "--public-key", "--url", "--out", "--notes"].contains(&key.as_str()) {
            return Err("Use --artifact <exe> --public-key <pub-file> --url <HTTPS-asset-url> --out <new-directory> [--notes <text-file>]".into());
        }
        let value = args.next().ok_or("Missing argument value")?;
        if options.insert(key, value).is_some() {
            return Err("Duplicate argument".into());
        }
    }
    let required = |key: &str| {
        options
            .get(key)
            .map(PathBuf::from)
            .ok_or_else(|| format!("Missing {key}"))
    };
    let artifact = required("--artifact")?;
    let public_key = required("--public-key")?;
    let out = required("--out")?;
    let url = options
        .get("--url")
        .and_then(|v| v.to_str())
        .ok_or("Missing UTF-8 --url")?;
    let url = url::Url::parse(url).map_err(|_| "Invalid asset URL")?;
    if url.as_str().len() > 2048
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.host(), Some(url::Host::Domain(host)) if host.contains('.') && !host.ends_with(".localhost"))
    {
        return Err("Asset URL must be public HTTPS without credentials, query or fragment".into());
    }
    if url.host_str() == Some("github.com")
        && !url
            .path()
            .starts_with("/somepoi/tarkov-companion-rust/releases/")
    {
        return Err("GitHub update assets must belong to the fork repository".into());
    }
    let version = env!("CARGO_PKG_VERSION");
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).map_err(|e| e.to_string())?;
    if config["version"] != version
        || config["identifier"] != "io.github.somepoi.tarkov-companion-rust"
    {
        return Err("Native package identity/version is inconsistent".into());
    }
    let product = config["productName"]
        .as_str()
        .ok_or("Missing native product name")?;
    let filename = format!("{product}_{version}_x64-setup.exe");
    if artifact.file_name().and_then(|v| v.to_str()) != Some(&filename) {
        return Err("Artifact filename does not match this fork/version/x64 installer".into());
    }
    let segment = url
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .ok_or("Missing asset URL filename")?;
    if percent_encoding::percent_decode_str(segment)
        .decode_utf8()
        .map_err(|_| "Invalid asset URL filename")?
        != filename
    {
        return Err("Asset URL filename differs from the installer filename".into());
    }
    let signature_path = artifact.with_file_name(format!("{filename}.sig"));
    let signature = text(&signature_path, 16 * 1024)?.trim().to_owned();
    let key = text(&public_key, 8192)?.trim().to_owned();
    let bytes = bounded(&artifact, update_signature::MAX_UPDATE_BYTES)?;
    let digest = update_signature::verify_update(&bytes, &key, &signature, version)?;
    let notes = options
        .get("--notes")
        .map(PathBuf::from)
        .map(|path| text(&path, 64 * 1024))
        .transpose()?
        .unwrap_or_default();
    if !available(&out)? || out.file_name().is_none() {
        return Err("Output must be a new directory".into());
    }
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    if !parent.is_dir() {
        return Err("Output parent directory must already exist".into());
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staging = parent.join(format!(".incomplete-update-{}-{nonce}", std::process::id()));
    let manifest = json!({"version":version,"notes":notes,"platforms":{"windows-x86_64":{"signature":signature,"url":url.as_str()}}});
    let release: tauri_plugin_updater::RemoteRelease = serde_json::from_value(manifest.clone())
        .map_err(|e| format!("Invalid updater manifest: {e}"))?;
    release
        .download_url("windows-x86_64")
        .map_err(|e| e.to_string())?;
    release
        .signature("windows-x86_64")
        .map_err(|e| e.to_string())?;
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
    if manifest_bytes.len() > update_signature::MAX_MANIFEST_BYTES {
        return Err("Update manifest exceeds the 512 KiB limit".into());
    }
    let evidence = json!({"kind":"tarkov-companion-rust-update-preparation","version":version,"platform":"windows-x86_64","artifact":filename,"bytes":bytes.len(),"sha256":digest,"signatureVerified":true,"signedVersionVerified":true,"published":false});
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    write(&staging.join(&filename), &bytes)?;
    write(
        &staging.join(format!("{filename}.sig")),
        signature.as_bytes(),
    )?;
    write(&staging.join("latest.json"), &manifest_bytes)?;
    write(
        &staging.join("release-evidence.json"),
        &serde_json::to_vec_pretty(&evidence).map_err(|e| e.to_string())?,
    )?;
    if !available(&out)? {
        return Err(
            "Output directory appeared during preparation; incomplete staging retained".into(),
        );
    }
    fs::rename(staging, &out).map_err(|e| e.to_string())?;
    println!("Prepared verified update files at {}", out.display());
    println!("SHA-256: {digest}");
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("Update preparation failed: {error}");
        std::process::exit(1);
    }
}

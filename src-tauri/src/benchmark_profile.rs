//! Measurement-profile ownership before normal single-instance integration.
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    sync::OnceLock,
};
static CLAIMED: OnceLock<PathBuf> = OnceLock::new();
pub fn explicit_profile() -> Option<String> {
    let args: Vec<_> = std::env::args().collect();
    args.iter()
        .find_map(|a| a.strip_prefix("--profile-dir=").map(str::to_owned))
        .or_else(|| {
            args.windows(2)
                .find(|a| a[0] == "--profile-dir")
                .map(|a| a[1].clone())
        })
}
pub fn claim() -> Result<(), String> {
    if !crate::desktop::benchmark_mode() {
        return Ok(());
    }
    let raw = PathBuf::from(explicit_profile().ok_or("Benchmark mode requires --profile-dir")?);
    if !raw.is_absolute()
        || !fs::symlink_metadata(&raw)
            .map_err(|e| e.to_string())?
            .is_dir()
    {
        return Err("Benchmark profile must be an existing absolute directory".into());
    }
    let profile = raw.canonicalize().map_err(|e| e.to_string())?;
    if let Some(claimed) = CLAIMED.get() {
        return if claimed == &profile {
            Ok(())
        } else {
            Err("Benchmark profile changed during startup".into())
        };
    }
    let root = profile.parent().ok_or("Invalid measurement profile")?;
    let named = root
        .file_name()
        .and_then(|s| s.to_str())
        .and_then(|s| s.strip_prefix("tc-desktop-baseline-"))
        .is_some_and(|suffix| {
            !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_alphanumeric())
        });
    if profile.file_name().and_then(|s| s.to_str()) != Some("profile")
        || !named
        || root.parent()
            != Some(
                std::env::temp_dir()
                    .canonicalize()
                    .map_err(|e| e.to_string())?
                    .as_path(),
            )
    {
        return Err("Benchmark profile must belong to a fresh measurement directory".into());
    }
    let launch = root.join("launch.json");
    if !fs::symlink_metadata(&launch)
        .map_err(|e| e.to_string())?
        .is_file()
    {
        return Err("Invalid measurement launch record".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(launch)
        .map_err(|e| e.to_string())?
        .take(64 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("Measurement launch record is too large".into());
    }
    let config: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid measurement launch JSON")?;
    let recorded_profile = config["profile"]
        .as_str()
        .ok_or("Missing measurement profile")?;
    let recorded_exe = config["executable"]
        .as_str()
        .ok_or("Missing measurement executable")?;
    if fs::canonicalize(recorded_profile).map_err(|e| e.to_string())? != profile
        || fs::canonicalize(recorded_exe).map_err(|e| e.to_string())?
            != std::env::current_exe()
                .map_err(|e| e.to_string())?
                .canonicalize()
                .map_err(|e| e.to_string())?
    {
        return Err("Measurement launch record does not match this process/profile".into());
    }
    if fs::read_dir(&profile)
        .map_err(|e| e.to_string())?
        .next()
        .is_some()
    {
        return Err("Benchmark profile is not fresh".into());
    }
    let mut marker = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(profile.join(".benchmark-owner.json"))
        .map_err(|e| e.to_string())?;
    marker
        .write_all(format!("{{\"pid\":{}}}", std::process::id()).as_bytes())
        .and_then(|()| marker.sync_all())
        .map_err(|e| e.to_string())?;
    CLAIMED
        .set(profile)
        .map_err(|_| "Benchmark profile was already claimed".to_owned())
}

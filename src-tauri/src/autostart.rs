//! Only this native fork's value in the current user's Run key is touched.
use std::path::Path;

#[cfg(windows)]
const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const NAME: &str = "Tarkov Companion Rust (native)";

/// Windows CommandLineToArgvW quoting, including trailing backslashes.
fn quote(value: &str) -> String {
    let mut result = String::from("\"");
    let mut slashes = 0;
    for ch in value.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            '\\',
            if ch == '"' { slashes * 2 + 1 } else { slashes },
        ));
        result.push(ch);
        slashes = 0;
    }
    result.extend(std::iter::repeat_n('\\', slashes * 2));
    result.push('"');
    result
}

pub fn command(profile_root: &Path) -> Result<String, String> {
    let binary = std::env::current_exe().map_err(|e| e.to_string())?;
    let binary = binary
        .to_str()
        .ok_or("Executable path is not valid Unicode")?;
    let profile = profile_root
        .to_str()
        .ok_or("Profile path is not valid Unicode")?;
    Ok(format!(
        "{} --minimized {}",
        quote(binary),
        quote(&format!("--profile-dir={profile}"))
    ))
}

#[cfg(windows)]
pub fn read() -> Result<Option<String>, String> {
    match windows_registry::CURRENT_USER
        .open(KEY)
        .and_then(|key| key.get_string(NAME))
    {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            let error = std::io::Error::from(error);
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(None)
            } else {
                Err(format!("Could not read native Windows autostart: {error}"))
            }
        }
    }
}

#[cfg(windows)]
pub fn write(command: Option<&str>) -> Result<(), String> {
    let result = match command {
        Some(value) => windows_registry::CURRENT_USER
            .create(KEY)
            .and_then(|key| key.set_string(NAME, value)),
        None => windows_registry::CURRENT_USER
            .options()
            .write()
            .open(KEY)
            .and_then(|key| key.remove_value(NAME)),
    };
    result
        .map_err(std::io::Error::from)
        .or_else(|error| {
            if command.is_none() && error.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|e| format!("Could not update native Windows autostart: {e}"))
}

#[cfg(not(windows))]
pub fn read() -> Result<Option<String>, String> {
    Err("Autostart is supported by this build only on Windows".into())
}
#[cfg(not(windows))]
pub fn write(_: Option<&str>) -> Result<(), String> {
    Err("Autostart is supported by this build only on Windows".into())
}

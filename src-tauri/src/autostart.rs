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

/// True when a Windows error means "the key or value is not there".
///
/// `windows-registry` converts a failed `RegOpenKeyExW`/`RegGetValueW` straight into
/// `std::io::Error::from_raw_os_error(HRESULT)`, so the numeric code arrives as a
/// negative HRESULT (for example `0x80070002` / `-2147024894`) instead of `ERROR_FILE_NOT_FOUND`
/// (2). Rust therefore reports `ErrorKind::Other`, not `NotFound`, and a missing value would
/// otherwise look like a failure. Both spellings are checked here.
#[cfg(windows)]
fn is_missing(error: &std::io::Error) -> bool {
    const ERROR_FILE_NOT_FOUND: i32 = 2;
    const HRESULT_FILE_NOT_FOUND: i32 = -2147024894; // 0x80070002
    matches!(
        error.raw_os_error(),
        Some(ERROR_FILE_NOT_FOUND) | Some(HRESULT_FILE_NOT_FOUND)
    ) || error.kind() == std::io::ErrorKind::NotFound
}

/// A short reason for a failing Windows call, without a raw HRESULT in the UI.
///
/// The OS text ("The system cannot find the file specified.") is kept; the
/// trailing machine form `(os error -2147024894)` is dropped, because it says
/// nothing a user can act on.
#[cfg(windows)]
fn reason(error: &std::io::Error) -> String {
    let text = error.to_string();
    let stripped = match text.find(" (os error ") {
        Some(index) => &text[..index],
        None => &text[..],
    };
    let stripped = stripped.trim();
    if stripped.is_empty() {
        "the system refused the change".into()
    } else {
        stripped.to_string()
    }
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
            if is_missing(&error) {
                // No autostart entry is the normal state, not a failure.
                Ok(None)
            } else {
                Err(format!(
                    "Could not read the Windows autostart entry: {}",
                    reason(&error)
                ))
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
            // Removing a value that is already absent is the desired end state.
            if command.is_none() && is_missing(&error) {
                Ok(())
            } else {
                Err(error)
            }
        })
        .map_err(|e| {
            format!(
                "Could not update the Windows autostart entry: {}",
                reason(&e)
            )
        })
}

#[cfg(not(windows))]
pub fn read() -> Result<Option<String>, String> {
    Err("Autostart is supported by this build only on Windows".into())
}
#[cfg(not(windows))]
pub fn write(_: Option<&str>) -> Result<(), String> {
    Err("Autostart is supported by this build only on Windows".into())
}

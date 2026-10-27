//! Only installation paths are extracted; launcher credentials are never retained.
use serde::Deserialize;
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LauncherPaths {
    games_root_dir: Option<String>,
    temp_folder: Option<String>,
}
fn small_text(path: &Path) -> Option<String> {
    if fs::metadata(path).ok()?.len() > 4 * 1024 * 1024 {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(4 * 1024 * 1024 + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() <= 4 * 1024 * 1024).then_some(text)
}
pub fn detect() -> Option<String> {
    let mut roots = Vec::new();
    if let Some(roaming) = std::env::var_os("APPDATA") {
        for file in ["settings", "settings.json"] {
            if let Some(text) = small_text(
                &PathBuf::from(&roaming)
                    .join("Battlestate Games/BsgLauncher")
                    .join(file),
            ) && let Ok(paths) = serde_json::from_str::<LauncherPaths>(&text)
            {
                if let Some(root) = paths.games_root_dir {
                    let root = PathBuf::from(root);
                    roots.extend([root.join("EFT"), root.join("EFT (live)"), root]);
                }
                if let Some(temp) = paths.temp_folder {
                    let temp = PathBuf::from(temp);
                    if temp
                        .file_name()
                        .is_some_and(|n| n.eq_ignore_ascii_case("Temp"))
                        && temp
                            .parent()
                            .and_then(Path::file_name)
                            .is_some_and(|n| n.eq_ignore_ascii_case("launcher"))
                        && let Some(root) = temp.parent().and_then(Path::parent)
                    {
                        roots.push(root.to_owned());
                    }
                }
            }
        }
    }
    let mut libraries = BTreeSet::new();
    for variable in ["ProgramFiles(x86)", "ProgramFiles"] {
        if let Some(directory) = std::env::var_os(variable) {
            let steam = PathBuf::from(directory).join("Steam");
            libraries.insert(steam.clone());
            if let Some(text) = small_text(&steam.join("steamapps/libraryfolders.vdf")) {
                for line in text.lines() {
                    let mut tokens = line.split('"').skip(1).step_by(2);
                    if tokens.next() == Some("path")
                        && let Some(path) = tokens.next()
                    {
                        libraries.insert(PathBuf::from(path.replace("\\\\", "\\")));
                    }
                }
            }
        }
    }
    roots.extend(
        libraries
            .into_iter()
            .map(|p| p.join("steamapps/common/Escape from Tarkov")),
    );
    roots.extend(
        [
            r"C:\Battlestate Games\EFT",
            r"C:\Battlestate Games\EFT (live)",
            r"C:\Games\EFT",
            r"D:\Battlestate Games\EFT",
        ]
        .map(PathBuf::from),
    );
    let mut seen = BTreeSet::new();
    for root in roots {
        if !root.is_absolute() || !seen.insert(root.to_string_lossy().to_lowercase()) {
            continue;
        }
        for candidate in [root.join("Logs"), root.join("build/Logs")] {
            if crate::logs::looks_like_logs(&candidate) {
                return candidate
                    .canonicalize()
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned());
            }
        }
    }
    None
}

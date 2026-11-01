fn main() {
    // Reject accidental private-key/wrong-key input before option_env! could
    // embed it in the application. Diagnostics never include the supplied text.
    if std::env::var_os("CARGO_FEATURE_STAGED_UPDATES").is_some() {
        use base64::Engine;
        if let Ok(key) = std::env::var("TC_STAGED_UPDATE_PUBLIC_KEY") {
            let key = key.trim();
            if !key.is_empty() {
                let valid = key.len() <= 8192
                    && base64::engine::general_purpose::STANDARD
                        .decode(key)
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .is_some_and(|text| {
                            text.lines().count() == 2
                                && minisign_verify::PublicKey::decode(&text).is_ok()
                        });
                assert!(
                    valid,
                    "TC_STAGED_UPDATE_PUBLIC_KEY must contain only a valid Tauri public key"
                );
            }
        }
    }
    println!("cargo:rerun-if-env-changed=TC_STAGED_INSTALL_ENABLED");
    println!("cargo:rerun-if-env-changed=TC_STAGED_UPDATE_ENDPOINT");
    println!("cargo:rerun-if-env-changed=TC_STAGED_UPDATE_PUBLIC_KEY");
    let manifest = std::path::Path::new("../electron/packs.generated.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rerun-if-changed=../electron");
    let content = match std::fs::metadata(manifest) {
        Ok(metadata) => {
            assert!(
                metadata.is_file() && metadata.len() <= 64 * 1024,
                "Invalid content pack manifest"
            );
            std::fs::read(manifest).expect("Read content pack manifest")
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => b"null".to_vec(),
        Err(error) => panic!("Inspect content pack manifest: {error}"),
    };
    std::fs::write(
        std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("packs-manifest.json"),
        content,
    )
    .expect("Embed content pack manifest");
    tauri_build::build();
}

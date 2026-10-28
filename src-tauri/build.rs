fn main() {
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

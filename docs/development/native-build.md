# Native development build

The native preview uses the existing React frontend with Rust/Tauri 2 and a separate data directory. Electron remains available while native searchbar, content-pack, recovery and other parity gates remain open. Current implementation and unverified gates are recorded in `docs/plans/2026-10-27-implementation-progress.md`.

Prerequisites: Windows MSVC build tools and Windows SDK, WebView2, Node/npm, and the Rust toolchain pinned by `rust-toolchain.toml`. Install JavaScript dependencies with `npm ci`.

Prepare recognition content once before using the scanner (public game catalog/images and a pinned English OCR model):

```powershell
npm run assets:prepare
npm run assets:check
```

This builds PvE and regular references with four download/decode jobs by default. `npm run scan:fingerprints -- --concurrency 1` reduces that bound. Source snapshots and checksum-addressed images remain under ignored `assets-src/scan/v2`; generated runtime files are under ignored `public/scan` and `public/ocr`. Failed image acquisition does not replace the previous generated scanner directory. Previous outputs are retained under `assets-src/generated-backups`, outside Vite's public files.

To rebuild without network access, use `npm run ocr:assets -- --offline` and `npm run scan:fingerprints -- --offline`. Offline preparation requires the corresponding cached catalog/image/model inputs. `--refresh` explicitly reacquires scanner images online; corrupt cached OCR models are retained and must be moved aside before reacquisition. Missing/unsupported catalog images are recorded as exclusions and shown as a review warning, never as evidence that inventory cells are empty. The integrity/provenance contract is in `docs/plans/2026-10-27-content-assets.md`.

```powershell
npm run check:rust
npm run lint:rust
npm run check:content
npm run lint
npm run dev:tauri
```

Native npm commands resolve Cargo from `CARGO`, PATH or the rustup directory under `CARGO_HOME` / the user's home. They prepend the selected tool directory only in the child environment; they do not modify the user's persistent PATH. A missing executable produces an actionable error. Tauri is invoked through its installed Node entry point without shell string interpolation. `npm run notices:rust` uses the same resolver.

To embed the frontend into a development executable:

```powershell
npm run assets:check
npm run build:tauri-ui
npm run assets:check -- dist-tauri
node scripts/native.mjs cargo build --locked -p tarkov-companion-rust --features custom-protocol
```

The executable is `target/debug/tarkov-companion-rust.exe`. Plain `cargo build` without `custom-protocol` expects the Vite development server. Use an absolute, separate `--profile-dir` when a fresh isolated data directory is required. Benchmark tooling additionally requires its explicit integration-disable flag and never uses a game executable. The benchmark protocol is in `docs/performance/baseline-protocol.md`.

`npm run build:tauri` requires valid content manifests, prepares JavaScript/native license notices and invokes the Tauri bundle build. `dist:desktop` also checks scanner/OCR assets, then requires the separate Lighthouse tile input for its existing content-pack step. Native notices use the locked Windows dependency graph, locally downloaded crate sources and version-pinned supplemental license texts. Ordinary UI builds and CI native compilation can omit generated content; that is compilation evidence only. An installer build does not establish native feature parity or authorize publication.

No test command is part of this migration's verification workflow, following the user's instruction. Existing test sources remain intact.

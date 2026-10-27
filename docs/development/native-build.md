# Native development build

The native preview uses the existing React frontend with Rust/Tauri 2 and a separate data directory. Electron remains available while native searchbar, content-pack, recovery and other parity gates remain open. Current implementation and unverified gates are recorded in `docs/plans/2026-10-27-implementation-progress.md`.

Prerequisites: Windows MSVC build tools and Windows SDK, WebView2, Node/npm, and the Rust toolchain pinned by `rust-toolchain.toml`. Install JavaScript dependencies with `npm ci`.

```powershell
npm run check:rust
npm run lint:rust
npm run lint
npm run dev:tauri
```

Native npm commands resolve Cargo from `CARGO`, PATH or the rustup directory under `CARGO_HOME` / the user's home. They prepend the selected tool directory only in the child environment; they do not modify the user's persistent PATH. A missing executable produces an actionable error. Tauri is invoked through its installed Node entry point without shell string interpolation. `npm run notices:rust` uses the same resolver.

To embed the frontend into a development executable:

```powershell
npm run build:tauri-ui
node scripts/native.mjs cargo build --locked -p tarkov-companion-rust --features custom-protocol
```

The executable is `target/debug/tarkov-companion-rust.exe`. Plain `cargo build` without `custom-protocol` expects the Vite development server. Use an absolute, separate `--profile-dir` when a fresh isolated data directory is required. Benchmark tooling additionally requires its explicit integration-disable flag and never uses a game executable. The benchmark protocol is in `docs/performance/baseline-protocol.md`.

`npm run build:tauri` prepares JavaScript/native license notices and invokes the Tauri bundle build. Native notices use the locked Windows dependency graph, locally downloaded crate sources and version-pinned supplemental license texts. Content assets still need to be generated or supplied separately. An installer build does not establish native feature parity or authorize publication.

No test command is part of this migration's verification workflow, following the user's instruction. Existing test sources remain intact.

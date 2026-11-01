# Native Windows staging installer plan

Goal: produce a local NSIS review artifact from the current native source and retain the same target in the existing manually dispatched Windows staging workflow. This is packaging, not installation, publication or signed-update rollout.

Keep fork identifier io.github.somepoi.tarkov-companion-rust, product Tarkov Companion Rust, per-user installation, separate data paths and disabled updates. Keep GPL/original attribution and both third-party notice files. Current WebView2 downloadBootstrapper mode requires network when its runtime is absent; do not describe this installer as offline-complete.

Steps: inspect packaging config/notices; build production frontend plus optimized native NSIS bundle using the pinned toolchain; record file hash, size, signature status and generated installer identity evidence without executing the installer; extend the existing staging workflow to build and separately upload the native NSIS output with missing-artifact failure. Preserve the Electron reference upload. No release event, write permissions or publish action is added.

Verification uses actual build output, generated packaging sources, asset integrity checks and independent source review. No tests, fixtures, install/uninstall/upgrade execution, screenshots or game interaction. Runtime coexistence, Windows versions, offline bootstrap, recovery and signed staged updates remain open gates. Rollback removes the staging addition and retains the existing Electron path; no user installation or data changes are made.

## Local packaging evidence

On 2026-11-01, at application source `bde17cb`, `node scripts/native.mjs tauri build --bundles nsis --ci` exited 0. Its production frontend hook passed; optimized native compilation completed in 4m38s and makensis produced one x64 bundle. Bundler output reported hash validation for downloaded NSIS 3.13 and nsis-tauri-utils 0.5.3 tools. The installer was not executed.

Artifact: `target/release/bundle/nsis/Tarkov Companion Rust_2.13.0_x64-setup.exe`, 15,006,203 bytes (14.31 MiB), SHA-256 `C4811C87744E93EA310500D230AE3A88D905D1FE38BFF54EF704310ADB938372`. Authenticode inspection reports NotSigned; this is an unsigned local staging artifact, not an approved release. The ignored build output remains local and is not committed or published.

Generated `target/release/nsis/x64/installer.nsi` confirms PRODUCTNAME Tarkov Companion Rust, BUNDLEID io.github.somepoi.tarkov-companion-rust, currentUser mode, user execution level, and default LOCALAPPDATA product directory. File instructions include LICENSE.txt and both notice files; copyright retains David04-09/GPL and fork attribution. These are packaging-source observations, not proof of installation/uninstallation coexistence. Generated defaults include manufacturer github and allowDowngrades true; release metadata and downgrade policy still need review before distribution. No offline WebView2 guarantee is made.

`npm run assets:check` exited 0 with 5309 scanner references and five OCR files. Workflow source review found a missing preparation step for offline Rust notices on fresh runners; pinned-toolchain preparation and locked Cargo fetch now precede native packaging. Follow-up review found no remaining P1/P2 issue in that fix. The manually dispatched workflow retains contents:read permissions, separate native/Electron artifact names and error-on-missing native output. It was not triggered remotely, and its full fresh-runner execution remains unverified.

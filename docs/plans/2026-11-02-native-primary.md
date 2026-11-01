# Native development and packaging as the primary path

The user clarified that the objective is the full local Rust/Tauri migration. Configuring a public signed-update channel is a later distribution concern, not a prerequisite for local development. The audit's runtime, recovery and feature-preservation requirements remain open where there is no evidence; this clarification does not waive them.

## Changes

- `npm run dev` and `dev:desktop` now invoke Tauri, with arguments forwarded to the native command. An explicit development config uses the `.dev` app identifier and product name, separating its application-data directory and single-instance identity from the installed native application. Global hotkeys remain machine-wide and conflicts remain visible.
- `npm run build`, `build:desktop` and `dist:desktop` invoke the existing complete Tauri pipeline: local asset validation, both notices, frontend type-check/build, optimized Rust host and NSIS packaging. The production app identifier remains unchanged.
- Explicit `dev:web`/`build:web` and `dev:electron`/`build:electron`/`dist:electron` retain reference paths. CI names its reference targets explicitly; manually dispatched staging still packages both hosts without publishing.
- README now describes the fork, native commands, data separation, backup scope and incomplete acceptance. The inherited README remains in `docs/electron-reference.md` as historical/reference documentation, preserving attribution without presenting upstream downloads or signing claims as current fork instructions.

## Verification and limits

Frontend lint and whitespace checks passed. Package/Tauri JSON and both workflow YAML files parse; local links in both README documents resolve. The earlier web and explicit Electron frontend builds completed successfully during this change. Fresh `npm run build` exited 0, including frontend type-check/build, optimized Rust compilation (3m08s) and NSIS bundling. Generated NSIS source retains the fork identifier and current-user install mode.

The resulting bootstrapper package is `target/release/bundle/nsis/Tarkov Companion Rust_2.13.0_x64-setup.exe`, 15,055,261 bytes, SHA-256 `28F66D919A6779883507EAD9DD3D76DFB8D5F41F6C5DA07479F486F93B793750`. Windows Authenticode reports `NotSigned`. This is a local build artifact, not an installed or signed release. Later builds can replace the same output path.

No tests were created or run. No installer, development application or game workflow was launched for this change; the development profile separation is established by config/source inspection, not observed runtime acceptance. No keys, update channels, release publication or existing profiles were changed. Full migration acceptance remains tracked by the execution ledger and feature inventory.

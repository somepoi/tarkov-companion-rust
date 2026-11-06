# Tarkov Companion Rust

Windows companion for Escape from Tarkov, migrating the [original Tarkov Companion](https://github.com/David04-09/tarkov-companion) to **Rust + Tauri**.

Tauri is the desktop host. The existing React/TypeScript interface runs inside WebView2; Rust provides native Windows integrations, physical inventory storage, planning, backups and recovery. The image matcher/OCR and shared log interpretation remain TypeScript workers. There is no permanent Node sidecar in the native app.

The primary development and installer commands now target Tauri. The Electron implementation is retained under explicit reference commands while migration acceptance is unfinished. See the [migration plan](docs/plans/2026-10-27-migration-plan.md), [execution ledger](docs/plans/2026-10-27-implementation-progress.md) and [feature inventory](docs/performance/feature-parity.md) for implementation evidence and open gates. Source/build success does not establish complete runtime parity.

## Run the native app

Prerequisites: Windows 10/11, Node.js 22+, the Rust toolchain pinned in `rust-toolchain.toml`, MSVC C++ build tools/Windows SDK and WebView2. The native launcher also finds Cargo in the usual user installation when it is absent from PATH.

```powershell
npm ci
npm run assets:prepare
npm run dev
```

Development uses its own `io.github.somepoi.tarkov-companion-rust.dev` identity/data directory, so it does not reuse the installed native profile or its single-instance lock. Global hotkey conflicts are still reported in Settings. Export/import progress deliberately when moving between profiles.

Asset preparation obtains scanner references and the pinned English OCR resources. It requires network access; subsequent builds validate the generated local files. Game catalogs and prices have their own online/cache lifecycle. This is not a promise that a fresh offline installation contains all game/map data.

## Build a local Windows installer

```powershell
npm run build
```

This checks content assets, generates notices, builds the React interface and optimized Rust host, then packages the configured NSIS installer. Output:

```text
target/release/bundle/nsis/Tarkov Companion Rust_<version>_x64-setup.exe
```

To embed the WebView2 runtime installer for machines without it:

```powershell
npm run build:tauri:offline
```

Both variants identify the same fork and reuse the bundler's output filename. A later build replaces that local output. No installer is executed or published by these commands. Default fork updates are disabled; signing-channel configuration is a separate distribution task and is not needed for local development. The original project's signing certificate/release policy does not apply to this fork.

## Features and data

The retained interface includes Dashboard, quests/tree, Story, Maps/drawings/routes, Keys, Ammo, Flea Market, manual Item Collection/Hideout, game-log review/history, timers and settings. Native desktop integrations include tray/windows, configurable hotkeys, capture, filename-based position tracking and the searchbar. Current runtime/Windows compatibility limits are tracked in the feature inventory above.

**Stash Manager** is the native physical inventory workflow: named containers, saved scan drafts, screenshot evidence, independent identity/quantity/FIR/state review, atomic revision-checked commits, partial/multiple registered views, history/undo, protected reserves and explainable KEEP/SELL/REVIEW. Recognition proposes facts; it does not confirm them. Uncertain stock, stale facts or incomplete requirements prevent confident surplus recommendations. It never sells or sends gameplay input.

The legacy Item Collection remains separately labeled checklist data. Its counts are not silently converted into physical stacks. Quest/hideout progression and existing exports remain available.

The Hideout tab includes a zoomable bunker floor plan with station dependencies, upgrade requirements, and build timers. Start timers and mark levels built manually. Timer completion can show a notification while the app is open.

Settings → Clean up now previews eligible older fork installers in Downloads and unused native content packs. Confirmation sends only unchanged previewed targets to the Windows Recycle Bin. Active resources, stash evidence, backups, prepared updates and browser caches are retained; automatic update cleanup remains disabled.

Tauri uses its separate app identifier `io.github.somepoi.tarkov-companion-rust` and application-data directory. The active directory is displayed in Stash Manager. Do not point it at the original application's profile or assume an original installation is migrated in place.

- Settings progress JSON/daily backups cover the existing interface progress stores.
- Native progress and inventory JSON/CSV exports use a system Save As dialog and report completion or cancellation. Inventory reports are not recovery backups.
- **Stash Manager → Full backup and recovery** additionally preserves the transactional database, retained screenshot evidence, settings and recognition corrections. Export can select another folder/disk.
- Recovery prepares a separate profile and retains the original. Returning to an older binary requires a compatible full recovery copy, not an ad hoc schema downgrade.
- Save drafts before backup/recovery. Unsaved edits are not part of saved-state exports.

Ordinary logs and user-triggered Windows screenshots are the integration boundary. No game-memory access, injection, network interception, gameplay input or automatic selling is implemented. This does not establish game-policy/anti-cheat approval. Optional position-shot recycling is separate from stash evidence and remains opt-in.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` / `dev:desktop` / `dev:tauri` | Launch native Tauri development |
| `npm run build` / `build:desktop` / `dist:desktop` / `build:tauri` | Build the native installer |
| `npm run build:tauri-ui` | Type-check/build the native frontend only |
| `npm run dev:web` / `build:web` / `preview` | Browser-only reference build |
| `npm run dev:electron` / `build:electron` / `dist:electron` | Explicit Electron reference development/build/package |
| `npm run lint` / `lint:rust` | Static frontend/native checks |
| `npm run assets:prepare` / `assets:check` | Prepare/validate scanner and OCR content |

Web and Electron reference builds both use `dist/`; rebuild the selected reference before previewing/running it. Tauri uses its separate `dist-tauri/`.

The manually dispatched Windows staging workflow retains separate native and Electron artifacts and does not publish releases. Experimental signed-update staging is documented separately in `docs/plans/2026-11-01-update-artifacts.md`; it is not part of normal local builds. Historical map/source instructions and the inherited app description remain in [the Electron reference](docs/electron-reference.md).

## Licence and attribution

Copyright (C) 2026 David04-09. Tarkov Companion is free software under the [GNU General Public License v3](LICENSE) or (at your option) any later version. Modified distributions must provide source under the same licence. It comes with no warranty. This fork retains the original copyright and attribution.

Third-party libraries, map/wiki data, OCR resources and game imagery keep their own terms: [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) and [THIRD_PARTY_NOTICES_RUST.txt](THIRD_PARTY_NOTICES_RUST.txt). In particular, Lighthouse imagery by re3mr is CC BY-NC-SA 4.0; game item pictures belong to Battlestate Games. Building a separate resource pack does not itself establish redistribution rights. Escape from Tarkov belongs to Battlestate Games; this project is not affiliated with or endorsed by it.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

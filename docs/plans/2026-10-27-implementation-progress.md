# Migration execution ledger

The user authorized implementation of the complete audit/roadmap on 2026-10-27 and allowed commits. They explicitly instructed: **do not create or run tests**. This overrides test-creation/test-execution steps in the proposed migration plan and inherited skills. Existing test files are left intact. Verification uses builds, type checking, lint, source review and observed application behavior; no test suite results are claimed for this implementation.

Branch: `codex/rust-stash-migration`.
Worktree: `D:/GITHUB/.codex-worktrees/tarkov-companion-rust-migration`.
Git author remains the configured `somepoi` identity. No push, tag, publication or AI coauthor trailers are authorized by this ledger.

## Scope and status

| Phase | Status | Remaining gate |
| --- | --- | --- |
| 0: fork isolation and recommendation safety | Implemented foundation | Installer coexistence/upgrade/uninstall remains unverified |
| 1: representative baseline and feature inventory | Tooling implemented | Real screenshot verification skipped at user request; comparable release measurements remain open |
| 2: desktop adapter and Tauri compatibility | Implemented foundation | Native embedded frontend reached React layout; full page/runtime compatibility remains open |
| 3: native desktop parity | In progress | GDI capture, configurable capture shortcut and native HKCU autostart implemented; logs, searchbar, packs and runtime parity remain open |
| 4: physical inventory and persistence | Implemented foundation | SQLite actor, revisions, scans, replay, undo, legacy separation and full backup/recovery implemented; recovery lifecycle remains unverified |
| 5: verified full-container workflow | Implemented foundation | Durable review/import/manual correction UI; six-container use and OCR accuracy unverified |
| 6: conservative requirement planner | In progress | Authoritative SQLite inventory/reserve integration and explanation UI implemented; objective partial hand-ins, broader state constraints and economic estimates remain open |
| 7: partial views and overlap | Pending | Registration, coverage and conflict semantics |
| 8: measured optimization | Pending | Comparable workload measurements |
| 9: assisted workflow and release | Pending | Windows installation/update/recovery and release assets |

## Decisions

- Keep the Electron reference target during the Tauri transition; preserve existing features.
- Separate fork identities before packaged runs. The first fork build disables updates (including manual actions) and automatic cleanup at the host level.
- Retain attribution. Fork content pack URLs are fork-owned and still hash-verified; missing staging assets are a visible error.
- User game screenshots and source application storage are never modified as part of environment setup or verification.
- Numerical performance claims require representative measurements. The audit's hidden paused smoke run is historical evidence only.
- On 2026-10-27 the user explicitly requested skipping verification on real game screenshots and continuing implementation. Do not fabricate corpus accuracy or scanner latency evidence.

## Implemented foundation

- Isolated Electron/Windows identities, fork-only installer cleanup, disabled updates/publication, review-first legacy recommendations and preserved unknown quantity/FIR facts.
- Tauri 2 adapter, local-origin restrictions, tray lifecycle, separate profile/WebView data, validated screenshot reads/archival and bounded GDI capture. Unsupported native methods return explicit migration errors; Electron remains the reference fallback.
- Transactional SQLite physical inventory, immutable container snapshots, revision conflicts, idempotent replay, undo, persistent scan drafts, checksum-verified screenshot evidence and separate legacy counts.
- New native Stash Manager route for named containers, screenshot import using the incumbent matcher, manual independent identity/quantity/FIR review and combined locations. Stack quantity recognition is not yet implemented; imported quantities remain unknown.
- Deterministic Rust allocator supports consuming requirements, sequential reusable tools, alternatives/FIR competition, reserve floors/buffers, never-sell and coverage gates. Native UI now calculates against authoritative SQLite snapshots and saved reserve preferences. Revision conflicts reject stale calculations and preference writes. Derived advice is invalidated by data changes, lost freshness confirmation and catalog expiry.
- Planning preferences persist per native profile in schema 2. Existing SQLite files receive a separate SQLite-API backup before migration. Hideout targets include dependency closure; selected craft/barter batches use validated API input quantities, preserve unsupported/fractional conditions as gaps, and share returned tools only across declared sequential crafts. Current quest/hideout progress is reused; full objective quantities remain reserved without inferring partial hand-ins.
- Physical allocation results are virtualized and include per-container, per-cell, per-source explanations. Wiki/unsupported/state conditions, missing/stale catalogs, unknown stock and incomplete container coverage block SELL. Prices do not influence reservation verdicts.
- Baseline scripts record launched process trees and UI readiness in isolated profiles; scanner benchmarking requires operator-supplied inputs and has not run.
- Portable native backup directories include a transactional SQLite copy, retained screenshot evidence, desktop settings, persisted interface stores and learned scanner references. Checksums, file/path/size limits, SQLite/reference validation and incomplete-directory staging protect import. Recovery prepares a new profile, activates it through an atomic pointer/restart and retains the original for rollback. Corrupt inventory/settings leave recovery access available. The complete contract and remaining runtime gates are in `2026-10-27-backup-contract.md`.
- Native capture shortcuts use the Tauri global-shortcut plugin. A replacement key is reserved before releasing the previous one; conflicts surface in Settings. Capture runs off the UI thread before restoring the app, permits one in-flight job, transfers PNG bytes through binary IPC and expires unread captures after 60 seconds. A pending-capture query handles frontend startup. This preserves the incumbent scanner hotkey workflow; container-targeted assisted capture remains future work.
- Native autostart uses only this fork's `Tarkov Companion Rust (native)` value under the current user's Windows Run key, with quoted executable/profile arguments. No HKLM or StartupApproved values are written. Integration changes roll back when settings persistence fails. Benchmark mode skips registration and autostart access. Actual registration/login behavior remains unverified.
- Native dependency notices are generated from the locked Windows graph, include author/source/license references and deduplicated full texts, and are packaged alongside the incumbent notices. Six packages needed explicitly versioned upstream/official license sources because their crate archives omit root license files. This is an attribution inventory, not proof of installer/release acceptance.

## Verification history

No tests were created or run for implementation. Historical audit test results do not establish the state of this branch.

- 2026-10-27: `npm run build:desktop`, `npm run build:tauri-ui`, `npm run lint`, `cargo check --workspace`, `cargo clippy --workspace -- -D warnings` succeeded. `cargo fmt --all` applied. Native embedded development executable built with `custom-protocol`.
- 2026-10-27: semver-compatible dependency security fixes applied after dry-run review; `npm audit --json` reported zero vulnerabilities. Electron and Vite updates are recorded in the lockfile.
- Native isolated hidden development observation: `docs/audit/2026-10-27/implementation/native-hidden-development.json`. React layout readiness observed at about 1087 ms with one-second polling; this is not first paint or interactive/catalog readiness. Two-second settling and five-second sampling are a smoke observation, not an idle/release/game performance baseline. Mean tree private bytes about 350.6 MiB; working sets double-count shared memory. No architecture speed/memory improvement is claimed.
- No game process, real game screenshots or original application profile were used or modified. Mixed-DPI capture, installation, upgrade, restore, native parity and scanner accuracy remain unverified.
- Planner integration checkpoint: TypeScript compilation, Tauri UI build, native embedded development build, lint and strict Clippy passed. Design detector returned no findings for the new planning/results surfaces. Runtime workflow is not established by these checks. One bounded visual inspection attempt in a fresh `tc-native-preview-*` profile failed because Windows capture returned `FrameArrived timed out` and then `window capture timed out`; the owned preview process was stopped. No screenshot recognition verification was attempted.
- Full-backup checkpoint: `npm run build:tauri-ui`, `npm run build:desktop`, `npm run lint`, `cargo clippy --locked --workspace -- -D warnings`, embedded native `cargo build --locked -p tarkov-companion-rust --features custom-protocol` and whitespace checks passed. The design detector returned no findings for backup/stash/health surfaces. No tests were created or run. Restore activation/restart and failure-recovery behavior are source-implemented but remain runtime-unverified.
- Capture/autostart checkpoint: Tauri UI build, TypeScript, lint, strict Clippy and embedded native build passed; Settings/Layout detector returned no findings. No OS shortcut/autostart mutation or screenshot capture was exercised during this checkpoint. Native notices generation completed with 277 crates and 166 distinct license texts; the incumbent notice generator includes `@tauri-apps/api`.

## Local build environment

During dependency fetching, the C: volume reached zero free space. With Rust jobs stopped, the Cargo registry and rustup directory were moved to `D:/GITHUB/.codex-cache/cargo-registry` and `D:/GITHUB/.codex-cache/rustup`. Junctions preserve their previous `C:/Users/Tecquo/.cargo/registry` and `C:/Users/Tecquo/.rustup` paths. No cache/toolchain files were deleted. About 1.25 GiB remained free on C: after relocation and subsequent compilation. Application/game data and Git identity were not changed. Cargo remains usable at its previous absolute executable path.

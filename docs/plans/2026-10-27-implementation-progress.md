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
| 3: native desktop parity | In progress | GDI capture implemented; logs, searchbar, hotkeys, autostart, packs and other parity remain open |
| 4: physical inventory and persistence | Implemented foundation | SQLite actor, revisions, scans, replay, undo and legacy separation; full backup/recovery remains open |
| 5: verified full-container workflow | Implemented foundation | Durable review/import/manual correction UI; six-container use and OCR accuracy unverified |
| 6: conservative requirement planner | In progress | Pure Rust global allocator compiles; authoritative integration, preferences and explanation UI remain open |
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
- Deterministic Rust allocator supports consuming requirements, sequential reusable tools, alternatives/FIR competition, reserve floors/buffers, never-sell and coverage gates. It is not yet exposed by the UI in this checkpoint.
- Baseline scripts record launched process trees and UI readiness in isolated profiles; scanner benchmarking requires operator-supplied inputs and has not run.

## Verification history

No tests were created or run for implementation. Historical audit test results do not establish the state of this branch.

- 2026-10-27: `npm run build:desktop`, `npm run build:tauri-ui`, `npm run lint`, `cargo check --workspace`, `cargo clippy --workspace -- -D warnings` succeeded. `cargo fmt --all` applied. Native embedded development executable built with `custom-protocol`.
- 2026-10-27: semver-compatible dependency security fixes applied after dry-run review; `npm audit --json` reported zero vulnerabilities. Electron and Vite updates are recorded in the lockfile.
- Native isolated hidden development observation: `docs/audit/2026-10-27/implementation/native-hidden-development.json`. React layout readiness observed at about 1087 ms with one-second polling; this is not first paint or interactive/catalog readiness. Two-second settling and five-second sampling are a smoke observation, not an idle/release/game performance baseline. Mean tree private bytes about 350.6 MiB; working sets double-count shared memory. No architecture speed/memory improvement is claimed.
- No game process, real game screenshots or original application profile were used or modified. Mixed-DPI capture, installation, upgrade, restore, native parity and scanner accuracy remain unverified.

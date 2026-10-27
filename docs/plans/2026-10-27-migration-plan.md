# Tarkov Companion Rust Migration Implementation Plan

> Implementation handoff: use `superpowers:executing-plans` for an approved phase, with its acceptance gate checked before proceeding.

**Goal:** Preserve the current companion features while introducing an isolated Tauri/Rust desktop host and a reliable, conservative multi-container Stash Manager.

**Architecture:** Keep the React/Vite frontend and TypeScript scanner initially. Replace Electron integrations behind the desktop interface, then put physical inventory/scan commits and the new recommendation planner behind Rust modules backed by SQLite. Keep the existing Electron application as the behavior reference until parity is demonstrated.

**Tech Stack:** Existing React/TypeScript/Vite, Tauri 2/Rust, SQLite, existing Web Worker matcher/Tesseract. Rust dependency versions and Windows capture implementation are selected in the corresponding spike, not assumed verified by this document.

**Status:** Proposed plan for review, not implementation authorization for the entire roadmap. No production changes have been made. Findings/evidence are in `2026-10-27-technical-audit.md` and `docs/audit/2026-10-27/`.

---

## Working rules and checkpoints

- Complete one focused task/PR at a time. Preserve the original copyright/license notices. Do not push/tag/publish as part of this audit.
- Use current Git user.name/user.email. Do not add AI author/coauthor names, Co-authored-by or Generated with Codex trailers.
- Never run the inherited installed-app/update smoke scripts against a real profile: they recursively remove the supplied directory. Introduce guarded fresh temporary directories before reusing them.
- All new paths below are **proposed** unless explicitly listed as existing; no Cargo/Tauri foundation currently exists.
- Each phase includes a rollback path. Rollback means restoring compatible code/data snapshots, not opening a newer schema with an older binary.
- Effort sizes below are planning estimates for one experienced engineer, not commitments: S = 1-3 working days, M = 3-7, L = 1-3 weeks, XL = 3+ weeks. Re-estimate after baseline and Tauri compatibility gates. Full desktop parity, safe planning and overlap handling are a multi-month effort, not a weekend rewrite.

## Phase 0 — Isolate the fork and close misleading recommendation paths

**Goal:** Make local packaging safe alongside the original and stop implying safe surplus where evidence is insufficient. Size M; two separate small changes.

**Existing files:** `package.json`, `electron/main.ts`, `electron/settings.ts`, `electron/updater.ts`, `electron/packs.ts`, `electron/cleanup.ts`, `electron/cleanup.test.ts`, `vite.config.ts`, `src/lib/app-info.ts`, `.github/workflows/release.yml`; then `src/lib/needs.ts`, `src/hooks/useNeeds.ts`, `src/components/ItemLookup.tsx`, `src/pages/FleaMarketPage.tsx`, `src/scan/ScanDialog.tsx`.

**Changes:** First complete the narrowly scoped identity task below. Next introduce a shared recommendation/completeness result, preserve missing/unsupported/FIR state and replace unqualified existing sell hints with REVIEW when their safety cannot be established. Until a physical inventory planner exists, use neutral text such as “No additional tracked need” for counted stock instead of a claim that the counted stock is saleable.

**Proposed new files for safety follow-up:** `src/lib/recommendationSafety.ts`, `src/lib/recommendationSafety.test.ts`, `src/lib/needs.test.ts`.

**Dependencies:** None. This phase precedes packaged baseline runs and all Stash Manager recommendations.

**Risks/tests:** Installer/data/update/cleanup namespace drift; mixed-version installations; missing hideout/tasks; unknown FIR; a counted item still reserved for a quest. Test pure identity/path/filename rules and shared verdict behavior. Explicitly test “have 8, need 8” protects the existing 8 while “need 0 more” is true.

**Acceptance:** Original app/profile/update cache/Downloads installers remain untouched. No upstream update can be applied to the fork. Missing requirements do not produce confident SELL. Existing quest/hideout/manual inventory functionality continues working.

**Rollback:** Revert the source change before distribution; retain isolated data. Do not distribute a rollback build that reuses original identifiers.

## Phase 1 — Reproducible baseline and feature inventory

**Goal:** Establish meaningful performance and accuracy baselines before choosing optimizations. Size M.

**Existing modules:** `scripts/scan-test.ts`, `scripts/scan-check-corrections.ts`, `scripts/ocr-node.ts`, `src/scan/core.ts`, `src/scan/scan.worker.ts`, `src/scan/ocr.ts`, `scripts/smoke-test-installed.mjs`, `scripts/update-test.mjs`, `.github/workflows/release.yml`.

**Proposed files:** `scripts/bench/desktop-baseline.mjs`, `scripts/bench/scan-baseline.ts`, `tests/fixtures/scan/manifest.json`, `docs/performance/baseline-protocol.md`, `.github/workflows/check.yml`. Real screenshots should be user-approved and privacy-checked; keep large fixtures/assets outside Git with hashes if appropriate.

**Changes:** Guard fresh temporary profile paths, pin environment/assets, separate cold initialization/OCR/grid/matching/review/commit timers, add a labeled representative corpus and JSON benchmark output. Add normal Windows CI for lockfile install/tests/lint/web+desktop typecheck/build. Do not silently regenerate the recognition corpus from live network on every test.

**Dependencies:** Phase 0 isolation; generated scanner/OCR assets and representative screenshots. No such real screenshot corpus was supplied in this audit.

**Risks/tests:** Private screenshot content; flaky live network; measuring only main process; synthetic accuracy mistaken for real-world accuracy. Validate fixtures and expected identities/quantities/boxes, retain failures in reports, separate warm/cold scans and report sample counts.

**Acceptance:** Reproducible Electron release measurements for startup, foreground/minimized idle, peak memory, total process CPU, GPU where available, OCR/matching/end-to-end p50/p95 and responsiveness. Initial feature-parity checklist includes all current pages and desktop integrations. Unknown quantities/FIR are labeled, not invented.

**Rollback:** Measurement tooling is independent of production behavior; preserve raw results and revert instrumentation if it affects timings.

## Phase 2 — Desktop adapter and Tauri compatibility spike

**Goal:** Prove that the existing frontend and scanner can run correctly in WebView2 before migrating the whole desktop layer. Size M-L.

**Existing files:** `src/shared/desktop-api.ts`, `src/main.tsx`, `src/desktop/useDesktop.ts`, `src/App.tsx`, `src/scan/scanner.ts`, `src/scan/ocr.ts`, `vite.config.ts`, `package.json`.

**Proposed files:** `src/desktop/adapters/electron.ts`, `src/desktop/adapters/tauri.ts`, `src/desktop/adapters/browser.ts`, `src/desktop/bootstrap.ts`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src-tauri/build.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/main.rs`, `src-tauri/capabilities/main.json`.

**Changes:** Install/verify Rust MSVC+C++ tools/WebView2 in the development environment. Initialize the adapter before React reads desktop identity. Reuse the DesktopApi contract and make unsupported spike capabilities explicit; retain the Electron build target. Load current app pages, create worker/ImageBitmap/OffscreenCanvas, load Tesseract WASM/English model from scoped resources, import/paste an image and exercise one recognition job. Verify English-only OCR limitation; Russian game text needs separate validation/model work.

**Dependencies:** Phase 1 fixtures and isolated profiles. Tauri is not currently buildable with tools found in PATH.

**Risks/tests:** CSP/asset protocol origin, wasm/blob workers, import/clipboard, AbortSignal browser support, HashRouter, cross-window storage, transparency and click-through searchbar. Test both dev and installed builds; a localhost dev success is insufficient.

**Acceptance:** Same fixture identities and review behavior in Electron/WebView2; explicit scoped resource access; core pages render; no duplicate business logic or permanent Node sidecar introduced. Early searchbar/capture spike establishes whether full parity is achievable.

**Rollback:** Use Electron adapter/build; keep frontend changes host-neutral. If critical parity fails, document the failing behavior and retain Electron while improving the inventory model.

## Phase 3 — Preserve native desktop behavior

**Goal:** Replace Electron integrations without losing existing companion functions. Size L.

**Existing modules:** `electron/{main,preload,capture,settings,security,position,positionShots,backups,packs,updater,cleanup}.ts`, `electron/logs/*`, `src/desktop/*`, `src/searchbar/*`, `src/lib/crossWindow.ts`.

**Proposed Rust modules:** `src-tauri/src/{desktop,windows,capture,resources,settings,logs,position,backups,packs,updates}.rs`; split into directories only when implementation size warrants it. Migrate pure log/position parser fixtures alongside the Rust versions.

**Changes:** Main/tray/searchbar lifecycle, single-instance behavior, autostart, conflict-aware configurable global hotkeys, noninvasive Windows capture, file selection/recent screenshots, custom resources/packs, log watching/backfill, review events, timers/wipe detection and safe backups. Select standard Windows capture backend in a spike; do not add game hooks. Port rules with golden fixture parity, including rotation/truncation/session-mode attribution. Preserve click-through/focus/mixed-DPI searchbar behavior or remain on Electron until it works.

**Dependencies:** Phase 2 compatibility gate and feature matrix.

**Risks/tests:** Dropped fs notifications, log rotation/truncation, large backfill blocking, hotkey conflicts, monitor/DPI mismatch, re-entry during update, binary/resource signatures. Run parser replay equivalence, IPC/capability validation, fixture pack corruption tests, native Windows smoke checks and selected live user-triggered checks. No game process access.

**Acceptance:** Existing desktop feature matrix passes with explicit evidence; release idle/startup comparison includes all WebView2 processes. Tauri update manifest/signatures and fork release source are tested in staging. No silent feature removals.

**Rollback:** Electron reference remains buildable until acceptance. Keep source exports and independently named Tauri profile; updates never automatically migrate an original installation in place.

## Phase 4 — Physical inventory and safe persistence

**Goal:** Persist containers, stacks and scan sessions atomically with recoverable migrations. Size L.

**Existing files:** `src/store/inventory.ts`, `src/store/progress.ts`, `src/lib/progressFile.ts`, `src/scan/learned.ts`, `src/desktop/HealthAndBackups.tsx`, `src/lib/crossWindow.ts`.

**Proposed files/modules:** `src-tauri/src/inventory/{mod,repository,scan_commit,migrations,legacy_import}.rs`, `src-tauri/migrations/0001_user.sql`, `src/inventory/{types,client}.ts`, migration/transaction integration tests.

**Changes:** Profile-scoped containers, current immutable snapshots, stacks with tri-state FIR and quantity/identity evidence, draft scan sessions/observations, screenshot references, recognition correction import, revisions/idempotency and undo rules. Add a single DB writer and derived aggregates. Persist and durably flush screenshot blobs before rename/reference commit, choose SQLite durability settings explicitly, and verify blob existence/checksums during recovery; filesystem and DB commits are not one atomic transaction. Keep catalog data separate; legacy collected counts stay separately labeled until reconciled.

**Dependencies:** Approved logical model and Phase 3 desktop storage access. Do not combine a shell rewrite and data conversion into one change.

**Risks/tests:** Power loss, disk-full, duplicate imports, missing/corrupt image blob, invalid counts/references, old/new schema mismatch, lost learned corrections, concurrent windows. Exercise transaction rollback, recovery of orphaned/missing/corrupt evidence and restore from a full backup using fresh temporary databases. Validate power-loss assumptions separately from a process-kill test.

**Acceptance:** Manual two-container inventory aggregates correctly across restart; repeat commit/import is idempotent. A profile/container-scoped commit key stores payload hash/result and is checked before expectedRevision; matching replay returns the old result, conflicting payload reuse fails. New invalid/stale-revision commits leave old data intact; backups restore DB+images+corrections; legacy source is untouched. No second writable aggregate inventory.

**Rollback:** Restore pre-migration snapshot/export and select old adapter. Migrations are forward-only in normal operation; rollback restores a complete compatible backup rather than attempting ad hoc destructive schema reversal.

## Phase 5 — Verified single-container screenshot workflow

**Goal:** Complete Phase A with honest full-container replacement. Size L.

**Existing modules:** `src/scan/{ScanDialog,scanner,scan.worker,core,ocr,learned,scanStore,undoApply}.ts*`, `src/config/nav.tsx`, `src/pages/ItemCollectionPage.tsx`.

**Proposed UI/domain files:** `src/pages/StashManagerPage.tsx`, `src/stash/{ContainerList,InventoryView,ScanReview}.tsx`, `src/stash/scanSession.ts`. Reuse existing components rather than copying the whole dialog into parallel implementations.

**Changes:** Container selection, draft session lifecycle, per-detection confidence/review, unknown regions, manual quantity/FIR confirmation, original screenshot evidence, request generations/cancellation and atomic commit through inventory module. Keep TS matcher initially. Add stackMaxSize to the adapted catalog; quantity OCR is a separate crop/parser and must not confuse durability/charges with stack count. Manual confirmation is a valid first version.

**Dependencies:** Phase 4 transactions, Phase 1 corpus. Scope starts with one fully visible user-selected grid; no implicit scrolling merge.

**Risks/tests:** Ambiguous items, identical items, partial visibility, changed profile while recognition runs, slow old job overwriting a new draft, repeated import after restart. Browser/worker integration tests plus transaction fixtures; test manual corrections survive restart and do not make an unreviewed stack certain.

**Acceptance:** Six independently named boxes can be scanned/reviewed, committed/reopened and aggregated with locations. Repeated scan replaces only the selected box; no duplication. Missing coverage/identity/quantity stays visible and cannot produce SELL. Unchanged matcher accuracy baseline is preserved or regressions explained.

**Rollback:** Discard uncommitted drafts, retain previous snapshots; keep current Item Collection workflow separately accessible until reconciliation is complete.

## Phase 6 — Explainable KEEP / SELL / REVIEW planner

**Goal:** Reserve actual physical stock against the player's declared requirements and protect uncertain decisions. Size L-XL.

**Existing modules:** `src/lib/{needs,progression,taskStatus,hideoutPlan,economy}.ts`, `src/hooks/{useNeeds,useProgressContext}.ts`, `src/api/{types,queries,hooks,persist}.ts`, current lookup/flea/scanner hints.

**Proposed modules:** `src-tauri/src/planner/{mod,requirements,allocation,recommendations}.rs`, `src-tauri/src/catalog/{mod,sync,validation}.rs`, planner fixtures/tests, `src/stash/RecommendationDetails.tsx`.

**Changes:** Normalize objective-level consumption/partial completion, FIR/state constraints and alternative groups; planned hideout target/dependencies, selected craft/barter batches, reusable tools, extra buffers/minimum floors and never-sell rules. Add barter loader/wire validation based on verified JSON schema. Mark wiki/branch/unsupported conditions as explicit coverage gaps. Use one deterministic global allocator; preserve existing progression facts and eventually retire replaced TS hints. Add mode-specific cached price timestamps and separate estimated proceeds from reservation verdicts.

**Dependencies:** Phase 5 trusted inventory; verified catalog shapes and explicit plan horizon. Move sync/planner ownership in separate substeps to avoid competing authorities.

**Risks/tests:** Double allocation, underspecified alternatives, unknown FIR, mutually exclusive quests, partially handed-in requirements, tool reuse, stale prices/inventory, invalid fractional counts, unknown wiki requirements. Property/invariant tests: allocations never exceed confirmed stock, a consuming unit is never allocated twice, removing trustworthy data cannot create a more permissive SELL, never-sell always protects, and aggregate/location counts agree.

**Acceptance:** Every portion has a reason and source/revision. Illustrative 25 owned /8 consumed /5 buffer produces 12 saleable only with complete trustworthy facts. Unknowns return REVIEW; required or protected stock stays KEEP. Price estimates do not trigger selling or automated game interaction. Offline analysis uses a last-known-good catalog with visible timestamps.

**Rollback:** Disable new verdict presentation and retain inventory facts. Previous planner version can recompute from snapshots; do not treat cached recommendations as authoritative inventory changes.

## Phase 7 — Partial views, overlap and rescans

**Goal:** Support scrolled/multi-image containers without false merging. Size XL, after the single-view workflow is useful.

**Modules:** `src/scan/core.ts` (recognition observations), proposed `src-tauri/src/inventory/registration.rs`, `scan_commit.rs`, `src/stash/ScanReview.tsx`, corpus/registration fixtures.

**Changes:** Absolute container coordinates, coverage masks, validated screenshot translation/registration, one stable-layout session, conflict resolution and explicit partial-scope patch semantics. Never merge/dedupe just by icon or item ID. Handle clipped items as observations of a possible full footprint. A crop hash caches recognition work but does not establish physical identity.

**Dependencies:** Phases 5-6 and real labeled scrolled/overlap sequences.

**Risks/tests:** Repeated-looking grids, moving items between views/containers, resized UI, unknown scroll offsets, screenshot order, duplicate but legitimate stacks. Test adverse layouts and require manual registration/review where confidence is insufficient.

**Acceptance:** Labeled overlaps count exactly once; duplicate legitimate items remain; incomplete coverage never deletes unseen regions; conflicting layouts do not auto-merge. Cross-container transfer after an old scan is explicitly reconciled or marked stale.

**Rollback:** Fall back to full-container replacement/manual reconciliation, preserving all snapshots and evidence.

## Phase 8 — Measured optimization

**Goal:** Improve demonstrated latency/resource costs without lowering correctness. Size M-L per independently measured bottleneck.

**Modules:** Only identified hotspots, potentially `src/scan/{core,ocr,scanner,scan.worker}.ts`, Rust `logs`, `packs`, `catalog`, inventory queries and virtualized stash list.

**Changes:** First evaluate OCR pre-processing worker move, worker/data idle release, bounded jobs, incremental log reads, streaming pack decode, catalog memory policy, cached descriptors/crops and existing list virtualization pattern. Consider Rust matching/quantity OCR only after flamegraphs and same-fixture comparison; keep algorithms/output contract and an A/B fallback. Avoid introducing OpenCV/GPU/large ML dependencies by assumption.

**Dependencies:** Reproducible release baseline and stable acceptance fixtures.

**Risks/tests:** Benchmark overfit, warm/cold bias, child-process exclusion, accuracy regression, worse game FPS. Report full pipeline p50/p95, failure/false-confident rates, peak/idle private memory and GPU/CPU where measurable alongside original reference.

**Acceptance:** Documented before/after results under the same workload; no correctness/parity regression. Product budgets are set from observed data, not invented in advance.

**Rollback:** Feature switch or previous implementation; preserve compatible descriptor/correction formats with versioned adapters.

## Phase 9 — Assisted workflow, backup/export and Windows release

**Goal:** Ship a polished local-first desktop app with controlled automation. Size L.

**Modules:** Rust capture/hotkeys/jobs/backup/update modules, `src/stash/*`, settings, `.github/workflows/release.yml`, notices/privacy/security docs.

**Changes:** Preserve existing configurable screenshot hotkey (Phase B); automatically prepare a draft from newly captured screenshots while requiring confirmation (Phase C); changed-region reuse only after validation (Phase D). Add full export/restore, database recovery, fresh-install/offline/runtime-bootstrap paths, signed staged updates and explicit data directories.

**Dependencies:** All required safety/parity/correctness gates, rights/source checks for distributed assets, fork release credentials owned by the user.

**Risks/tests:** Windows 10/11 and mixed DPI, missing WebView2, offline install, upgrade/uninstall beside original, update interruption, wrong profile, user confusion about stale inventory. Run VM installation/update/restore tests and targeted hands-on screenshot workflow checks. Do not read game memory, inject, intercept game traffic, automate input/gameplay or sell automatically.

**Acceptance:** Installer/update/uninstall never touches original data; full recovery tested; notifications/errors explain required review; assisted capture does not silently mutate inventory. Release notes distinguish measured guarantees from policy uncertainty.

**Rollback:** Stop rollout, retain isolated Electron/Tauri prior installer and compatible backups; no auto-downgrade into a newer incompatible database.

## Exact first implementation task — fork isolation

This is the smallest useful first task because the inherited updater/cleanup/install namespaces make a normal packaged baseline unsafe alongside the original. It does not require approving the complete Tauri architecture.

**Expected behavior:** Fork and original can coexist. The fork never updates from upstream, never modifies original userData/autostart/update cache, and never recognizes original Downloads installers as its cleanup targets. Existing application attribution remains.

**Proposed identity defaults:** package name `tarkov-companion-rust`; product/data directory `Tarkov Companion Rust`; appId/AUMID `io.github.somepoi.tarkov-companion-rust`; repo `somepoi/tarkov-companion-rust`; installer prefix `TarkovCompanionRust`; updater cache `tarkov-companion-rust-updater`; a freshly generated, then fixed NSIS GUID distinct from `0077fda7-d95b-5e13-bc16-23478dc4fd96`. Do not change upstream copyright author to imply ownership of their work.

**Files to create:** `electron/appIdentity.ts`, `electron/appIdentity.test.ts`. Keep this pure metadata/path construction so tests do not import the Electron runtime. Read package build metadata through the build configuration or a supplied metadata object; avoid a second independent hardcoded repo/appId.

**Files to modify:**

| File | Exact responsibility |
| --- | --- |
| `package.json` | name/product/build appId/new GUID/artifact/shortcut names; disable publish config initially; homepage/repository fork URLs; preserve license/author notices |
| `package-lock.json` | Update root package metadata consistently using lockfile-only package tooling; do not opportunistically upgrade dependencies |
| `vite.config.ts` | Supply shared build identity/repo metadata to shell and renderer |
| `electron/main.ts` | Set fork userData/identity before single-instance lock; fork title/tray labels, autostart identity and cleanup cache; updater disabled until staging |
| `electron/settings.ts` | Default fork updates and cleanup off until isolated flows are verified |
| `electron/updater.ts` | Fork-owned release/cache/artifact references; no upstream fallback; no download/install in initial isolated build |
| `electron/packs.ts` | Explicit fork/pinned source policy matching manifest/version; no hidden upstream-by-fork-version assumption |
| `electron/cleanup.ts` | Match only fork artifact prefix; reject original installer filenames |
| `electron/cleanup.test.ts` | Mixed original/fork Downloads fixture with original files always excluded |
| `src/lib/app-info.ts` | Fork display name/repository while keeping original credits |
| `.github/workflows/release.yml` | Fork filenames; disable publication/signing steps until staging and fork credentials are configured |

**Reviewable steps (split larger edits into short changes):**

1. Inspect current Git user.name/user.email without changing them; record a clean starting diff. Generate the new installer GUID once.
2. Add pure identity tests asserting original/fork identifiers, data/cache locations and artifact prefixes differ; include Windows case/path normalization and reject traversal/outside-root cleanup targets. Run `npm test -- electron/appIdentity.test.ts` and verify the intended failure before implementation.
3. Introduce the pure identity module fed by one build metadata source. Re-run the targeted test until it passes.
4. Update package/root lock metadata and build-time identity defines; preserve attribution. Check `npm ls --depth=0` for metadata/dependency consistency.
5. Wire userData/AUMID/single-instance/autostart identity before startup side effects. Add a controlled smoke observation of the actual resolved paths with fresh temporary data; no original-profile import.
6. Disable update/download/install and automatic cleanup in the first isolated build, including manual updater actions. Specify how fork content packs are supplied for staging; fail clearly if they are unavailable.
7. Add the mixed installer-name cleanup test; verify failure against the old matcher, implement fork-only matching, and verify it passes.
8. Update artifact names/display URLs/workflow paths. Check that remaining upstream references are intentional attribution/documentation, not active updater, pack or cleanup targets. Suggested search: `rg -n 'David04-09|tarkov-companion-updater|TarkovCompanion-|0077fda7|io.github.david04-09' package.json electron vite.config.ts .github src/lib/app-info.ts`.
9. Run `npm test`, `npm run lint`, `npm run build`, `npm run build:desktop`. Inspect exit codes and warnings; do not use test counts from this audit as a fixed future count.
10. In an isolated VM/test profile, run a staged package next to the original with simulated mixed installer files and network capture/log assertions for update URLs. Verify uninstall leaves both user profiles intact. Build content assets before `npm run dist:desktop`; that command needs map/scanner assets missing from this checkout.
11. Present the concrete diff and evidence for review. Commit only if requested/appropriate using existing Git identity, without AI trailers; no push/tag/publication.

**Acceptance:** All tests/builds pass; installer identities are distinct; resolved data/cache paths belong to the fork; original installer names are ignored; updates remain disabled until a fork-owned staged update passes. Original copyright/credits are retained. A full source review checks no startup side effect still targets the original namespace.

**Next task after isolation:** REVIEW-first wording/completeness guard from Phase 0, then representative baseline fixtures. Neither requires immediately porting the scanner or replacing the UI.

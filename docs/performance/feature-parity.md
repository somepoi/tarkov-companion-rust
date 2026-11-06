# Feature inventory and migration evidence checklist

Status: inventory from source inspection, not a passing runtime checklist. Checkboxes remain open until there is explicit runtime evidence; no tests were created or run for this inventory. The Electron host has been removed; runtime parity remains unverified. Source presence does not establish current data freshness, compatibility or scanner accuracy.

| Capability to preserve | Existing source seam | Evidence required before marking parity |
| --- | --- | --- |
| Main startup, lazy routes, HashRouter/browser behavior | `src/main.tsx`, `src/App.tsx`, `src/config/nav.tsx` | Correct host/window chosen before React; dev and packaged navigation |
| Dashboard, Events, Stats, Quests/tree, Story | `src/pages/*`, `src/quests/*`, `src/story/*` | Equivalent pages, state, offline/missing-data behavior |
| Maps, imagery/floors, task/loot/boss overlays | `src/maps/*`, `src/maps/overlay/*` | Layer changes, pack/remote resources, coordinates and attribution |
| Drawings, route planning and raid briefing | `src/store/drawings.ts`, `src/store/routePlan.ts`, `src/briefing/*` | Persistence and multi-window consistency |
| Keys, Ammo, item lookup and Flea Market | `src/pages/*`, `src/components/ItemLookup.tsx` | Search/filter/large-list virtualization and price freshness |
| Item Collection and Hideout manual progression | `src/store/inventory.ts`, `src/pages/ItemCollectionPage.tsx`, `src/pages/HideoutPage.tsx` | Existing counts/levels survive; missing requirements never imply safe sale |
| Separate PvE/regular profiles, level/faction and quest status | `src/store/progress.ts`, `src/lib/progression.ts` | Profile switching, explicit/inferred completion distinction, manual management |
| Live log sync and historical review/undo | `src-tauri/src/logs.rs`, `src/shared/logs/*`, `src/desktop/useDesktop.ts`, `src/desktop/syncHistory.ts` | Mode/time/profile attribution, replay/truncation/rotation, no duplicate application |
| Wipe/reset/archive flow | `src/desktop/wipe.ts`, `src/store/archives.ts` | User review and recoverable archives without silent reset |
| Raid/scav/story timers and notifications | `src/desktop/timers.ts`, `src/story/*` | Deadline correctness, hide/restore behavior and optional sounds |
| Scanner paste/drop/file/recent-image import | `src/scan/ScanDialog.tsx`, `src-tauri/src/capture.rs` | Correct image, explicit errors and request-generation handling |
| Existing image matching and English OCR | `src/scan/{core,scanner,scan.worker,ocr}.ts` | Real supplied corpus, local WASM/model resources, confidence/correction review |
| Manual boxes/alternatives/quantities and last-apply undo | `src/scan/boxEdit.ts`, `src/scan/ScanDialog.tsx`, `src/scan/undoApply.ts` | No lost edits; aggregate checklist semantics clearly distinguished from containers |
| Learned positive/negative/confirmed references | `src/scan/learned.ts`, `src/scan/LearnedPanel.tsx` | Persistence, independent export/import, no falsely certain unreviewed observation |
| Capture hotkey and monitor selection | `src-tauri/src/lib.rs`, `src-tauri/src/capture.rs` | Explicit capture before app focus; mixed DPI/monitor/black-image handling |
| Main window, tray, minimize/close/restore, single instance | `src-tauri/src/lib.rs`, `src/shared/desktop-api.ts` | Windows lifecycle and existing-instance activation |
| Configurable global hotkeys and autostart | `src-tauri/src/lib.rs`, `src-tauri/src/desktop.rs` | Conflict errors, saved configuration, independent fork registration |
| Searchbar transparent/click-through/focus/lock behavior | `src/searchbar/*`, `src-tauri/src/lib.rs` | Transparent region passthrough and re-entry, keyboard release, edge/DPI positioning |
| Position from screenshot filename and opt-in cleanup | `src-tauri/src/position.rs` | Read-only default, retained coordinates and safe opt-in recycling; no stash-evidence deletion |
| Catalog mode/translation/cache and stale/offline states | `src/api/*` | Last-known-good data across upgrade; source/mode/timestamps and coverage gaps |
| Preferences, export/import and daily backups | `src/lib/progressFile.ts`, `src/desktop/HealthAndBackups.tsx` | Complete preservation inventory, validation and restore in an isolated profile |
| Packs/OCR/maps resource loading | `src-tauri/src/packs.rs`, `src-tauri/src/capture.rs`, `vite.config.ts` | Hash verification, scoped paths/CSP, offline and missing-pack errors |
| Updates, cleanup, installer/uninstaller identity | `src-tauri/src/updates.rs`, `src-tauri/src/cleanup.rs`, `package.json` | Fork-only paths/artifacts/source, staged signed update, original install/data untouched |
| Security and licenses | `src-tauri/src/navigation.rs`, `LICENSE`, `THIRD_PARTY_NOTICES.txt` | Per-window permissions/path validation/navigation restrictions and retained notices |

## Evidence log

For each reviewed capability record host/build/version, date, environment, controlled input hashes, observed behavior, limitations and evidence location. An unchecked box is unresolved, not a failure claim.

- [ ] Electron reference behavior recorded with isolated data.
- [ ] Tauri development behavior recorded.
- [ ] Tauri packaged Windows 10 behavior recorded.
- [ ] Tauri packaged Windows 11 behavior recorded.
- [ ] Mixed DPI/multi-monitor behavior recorded where relevant.
- [ ] Offline/upgrade/restore behavior recorded where relevant.
- [ ] Feature-specific blockers and rollback route reviewed.

Current inventory does not claim that container snapshots, stack quantity/FIR recognition, scroll registration or intelligent global allocation existed in the original application. Track new Stash Manager acceptance separately from preservation of old features. Removed Crafts/weapon-builder/assistant pages are not current UI parity requirements merely because helper code or old preferences remain.

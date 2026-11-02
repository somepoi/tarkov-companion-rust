# Native map catalog adaptation

Continue native catalog ownership by moving the complete map view into `stash-core::catalog::maps`. Task/objective and trader adaptation remain separate; the shared game bundle now consumes the native map view in Tauri.

## Preserved map view

- Map identity/name/scene/raid-duration headers, translated loot-container names, mob names and portraits, and latest finite community goon-report timestamps. Numeric/decimal-string timestamp selection and stable descending ordering remain; missing timestamps are not invented as zero.
- Extracts, transits, spawn sides/categories/zones, bosses and their locations/escorts/count alternatives/timing/triggers, loose and container loot, locks, hazards, switches, stationary weapons and BTR stops.
- Source positions and outlines are retained. Positions are required to be objects where the old required layer record expects a position; the adapter does not infer coordinates or claim geometry validation. Existing optional-row filters and the BTR zero-height fallback remain.
- Switch fallback labels follow the existing rule order, including extract/power/elevator/alarm/gate/pump/water/lever/console/hidden/button names. English dictionary values take priority.
- Placeholder car-trunk keys are counted across all maps before filtering; a key with more than three trunk locks has those trunk entries removed. Other lock entries remain.
- Frontend locale sorting, endpoint-catalog checks, composite game-data query keys/schema/offline persistence and abort-result guards remain. Browser/Electron retain the extracted TypeScript reference path. Native errors do not silently fall back to a second parser.

## Execution and admission

- Map base/English documents use the existing fixed-source transport and the shared native adapter broker. Main/searchbar consumers coalesce by mode and kind, now six possible adapter jobs (items/hideout/maps × two modes), with the existing 16-consumer bound.
- The IO lease covers actual reads and off-thread normalization, including after a consumer leaves. Completed results are removed after publication rather than becoming another long-lived cache.
- Bounds: 512 maps, 16,384 entries per definition dictionary, 262,144 rows per layer list and 1,048,576 nested rows overall. Source documents retain their existing decoded limits. IDs and translated text are bounded; a conservative 64 MiB output accounting budget includes rows before insertion as well as enclosing maps, intentionally overcounting nested content to constrain expansion. No partial/truncated layer view is published when a limit is exceeded.
- Malformed IDs, required positions, boss/location/report records, duplicate map IDs and unsupported list/dictionary shapes fail the refresh. Stricter rejection than the permissive reference is intentional; live producer compatibility has not been established.

## Verification and remaining work

Source review, lint, TypeScript/frontend/reference/native compilation, strict Rust checks and formatting verify integration. No tests, fixtures, live API calls, application launches or profile operations run. Actual producer compatibility, map/overlay rendering, offline/restart/abort behavior and resource measurements remain unverified. Task/objective/trader adaptation and broader migration/release acceptance remain open.

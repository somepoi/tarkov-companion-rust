# Native task/objective adaptation and progress-definition compatibility

Continue Phase 6 catalog ownership by moving the complete task/objective adapter into `stash-core::catalog::tasks`. The native game-data command now composes tasks with the shared native map and trader views. The incumbent TypeScript path remains for browser/Electron.

## Preserved task view

- Quest identity/names, trader/map references and unknown-trader fallback, level/experience/faction flags, images/wiki links, prerequisites/statuses, other-requirement descriptions, delays, story/dialogue gates, required keys, trader requirements and standing.
- Objective identity/type/description/optional flag, maps, nullable counts/FIR, accepted item alternatives, quest-item names/icons, target names, zones/possible locations/keys/exits, markers, weapon/part/outfit groups, shot/body/distance/hour restrictions and weapon-build limits.
- Dogtag-level and durability restrictions retain the existing validation/gap rules. Malformed/too-many alternatives produce gaps rather than broad eligibility. `useAny` precedence, missing-use-alternative review, deduplication order and unknown quantities are preserved.
- Complete raw definitions, including restrictions not yet modeled, are retained as `planningDefinition` for the existing consumption/holding/use objective kinds. No partial hand-ins are inferred or silently migrated. Existing progress facts still require the same definition, total and lifecycle confirmation.

## Canonical definitions

The old helper sorts keys, creates ordinary JavaScript objects, then uses JSON.stringify. A plain Rust map serializer does not express the same rules. The dedicated serializer writes array-index property names first in numeric order, other property names in UTF-16 order, keeps array order, escapes admitted Unicode strings with serde_json, and formats finite f64 numbers with the ECMAScript-oriented [ryu-js implementation](https://github.com/boa-dev/ryu-js). This includes zero/sign/exponent spelling rather than Rust's ordinary float display. Native serde_json parsing enables `float_roundtrip` before converting numeric values to that representation.

Source reasoning follows [ordinary property-key ordering](https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryownpropertykeys) and [JSON serialization](https://tc39.es/ecma262/multipage/structured-data.html#sec-json.stringify). The supported domain is the finite-number, valid-Unicode JSON already admitted by native transport; this is not a general serializer for arbitrary JavaScript objects/functions/undefined or lone UTF-16 surrogates. Nesting is capped at the incumbent depth of 32 and a definition at 1 MiB. Compatibility is intended and source-reviewed, not proven by cross-runtime execution or saved-counter fixtures.

## Execution and boundaries

- Main/searchbar invoke `load_game_catalog` after the existing frontend endpoint check. The shared broker has ten possible mode/kind jobs and 16 waiting command consumers. A game-data job shares map/trader dependencies and waits for all required data before publication; dependencies never hold the broker mutex across awaits. A boxed internal result future breaks the recursive opaque Send-type dependency.
- Native IO leases cover actual dependency acquisition and off-thread normalization even after a consumer leaves. Completed results are removed, without another long-lived cache. Failure retains the existing query's last-good persisted copy and has no TypeScript fallback in Tauri.
- Frontend code restores the shared task/map/trader object references that JSON cannot preserve, builds `tasksById` from the returned task array and keeps locale sorting. It does not re-adapt native quest fields. Existing query keys, planning schema 2, saved progress and inventory data remain.
- Bound 8192 tasks, 16,384 rows per list/quest-item dictionary and 1,048,576 admitted list rows overall. IDs, depth, translated text and definitions are bounded; a conservative 64 MiB accounting budget charges generated translations, dialogue names, nested output and enclosing records before retaining repeated copies. Exceeded/malformed/duplicate identity limits reject refresh rather than truncate tasks.
- Add locked ryu-js 1.0.3 and regenerate native notices. No database migration or runtime/user-profile operation is performed by this checkpoint.

## Verification and remaining work

Source review, lint, frontend/reference/native builds, formatting and strict Rust checks verify integration. No tests, fixture documents, cross-runtime comparisons/simulations, live API downloads, application launches or user-profile operations run. Producer/runtime compatibility, real saved-counter compatibility, offline/abort behavior and memory/performance remain unverified. Objective-to-demand normalization, broader planner condition/eligibility coverage and migration/release acceptance remain open.

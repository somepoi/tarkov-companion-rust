# Native objective-to-demand normalization

Move the Stash Manager requirement rules from the synchronous TypeScript preview into `stash-core::requirements`. The retained TypeScript builder is a source/reference implementation; native planning no longer calls it to derive demand.

## Preserved rules

- All unfinished faction quests; explicit partial hand-ins only when total, definition, status and active/nonfailed lifecycle match. Stale/orphaned/unparsed counters keep full demand and add review gaps. Native definition checks reuse the canonical serializer introduced by the task adapter, including the older fallback definition shape.
- Consuming, possession/holding, marker and use objectives remain distinct. Unknown physical use/charge conversion, fitted builds/presets and unsupported item objectives still require review. Quantity/FIR/dogtag/durability uncertainty is retained.
- Direct any-dogtag alternatives retain validation, deduplication and bounds; ordinary presets do not expand into physical parts. Missing item metadata does not release stock.
- Hideout selection still includes dependency closure/intermediate levels; omitted targets mean all known levels and zero excludes a station unless another upgrade requires it. Selected craft/barter batches, sequential tool groups, unlock quests, trader loyalty/current availability checks and recipe coverage gaps remain.
- User buffers/floors/never-sell rules stay in the persisted native planning preferences and allocator. No checklist totals or inferred completion subtract from physical demand.

## Native authority and preview

- `calculatePlan` accepts projected catalog/progression facts as `normalizationInput`, rather than accepting renderer-prepared requirement rows. After checking native plan/container revisions, the actor replaces projected preferences with the saved SQLite preferences, rebuilds requirements, merges native gaps with frontend freshness/availability gaps, and runs allocation against native inventory/reserves in the same serialized job.
- Frontend progression/catalog copies remain declared input facts; this is not cryptographic attestation of browser storage. The renderer still supplies current-catalog availability, age/schema and character/inventory confirmation context. Native normalization gaps independently prevent complete sale advice.
- A main-only read-only actor operation supplies the dependency preview using the same pure normalizer. The UI projects only needed fields, excluding pictures/map layers/economy/unparsed recovery payloads. One preview runs at a time, with one replaceable latest intent and a 200 ms debounce. Input identity gates late results, calculation stays disabled without a current preview, and failed review has an explicit retry. Native computation is not claimed cancellable.
- The preview itself does not mutate SQL facts, saved preferences or stock. Final calculation recomputes independently; preview rows are never treated as a committed plan. Existing event/freshness/signature invalidation remains.

## Boundaries and unknown data

- Existing 8 MiB request/16-job actor admission remains. Source supports at most 8192 tasks, 512 stations, 32,768 items and 8192 objective-progress task groups. At most 8192 derived requirement rows/unique coverage gaps and 1,048,576 counted expansion visits are admitted. Planner identity/source/gap bounds apply before accumulating output. A limit failure rejects the operation, without a truncated successful plan.
- Missing required catalog arrays, malformed hideout levels, selected-recipe condition/input lists and nonboolean tool/present invalid dogtag conditions reject normalization. They cannot establish that no demand exists. Unknown numeric quantities/FIR remain coverage gaps. Invalid current station levels retain an explicit gap and conservative known upgrade demand.
- The normalizer validates planning preference bounds. No database schema, progress format, source screenshot or backup is rewritten. The internal calculation IPC shape changes with this paired frontend/backend build; older renderer requests are rejected instead of silently using their old demand rows.

## Verification and remaining work

Lint, frontend/reference/native compilation, formatting, strict Rust checks and independent source review verify source integration. No tests, fixtures, comparisons/simulations, live API requests, applications or user-profile operations run. Runtime preview/retry/stale-response behavior, real partial counters, native/reference parity, workload performance and full planner/release acceptance remain unverified. Broader fitted-build/item-state/eligibility coverage and migration runtime gates remain open.

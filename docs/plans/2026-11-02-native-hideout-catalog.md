# Native hideout catalog adapter

Continue Phase 6 catalog adaptation ownership after native recipe normalization and the shared game-document transport. The native hideout path now returns the existing page-facing station array from Rust.

## Preserved contract

- Station IDs, English/fallback names, normalized names and image links; sorted levels with IDs, level numbers and construction times.
- Trader and station dependencies, material IDs/counts/FIR, translated skill requirements, bonuses (including negative values) and translated descriptions.
- Integer nonnegative material amounts within JavaScript's safe integer range remain numbers; missing, fractional, negative or out-of-range amounts remain null. FIR is a boolean only when supplied as one; otherwise it remains null. No unknown becomes one or non-FIR.
- Translation uses a nonempty English dictionary value or the existing field-specific fallback. Missing/null optional requirement lists remain empty, matching the reference adapter. Levels sort numerically in Rust; station names retain the frontend's locale-based sorting.
- Existing persisted query keys, array shape and freshness timestamps remain. No new writable native cache or inventory conversion is introduced. Browser/Electron keep the reference TypeScript adapter. A failed native refresh is surfaced without silently switching parsers; the existing offline copy remains available through query persistence.

## Native boundary

- Both main and searchbar may request the existing game-mode enum. Fixed base/English routes use the coalesced native transport concurrently, including its route/decoded-byte/HTTP limits. No new arbitrary URL capability is introduced.
- At most four hideout adapter calls are admitted, without a waiting queue. The IO lease remains held through the actual off-thread adaptation. Both documents must succeed before normalized data is returned. Query aborts reject late results; shared transport reads can finish for other consumers.
- The pure `stash-core::catalog::hideout` adapter uses typed serialized output. It rejects malformed station/level/dependency/item identities and numbers instead of dropping them. Duplicate station IDs, level IDs or level numbers are rejected. This is stricter than the reference's silent station/item filtering and permissive numeric passthrough; producer compatibility is not inferred from compilation.
- Workload limits: 512 stations, 256 levels per station, 4096 entries per optional list and 65,536 optional-list entries in total; identifiers up to 512 UTF-8 bytes, image text up to 4096 bytes and translated text up to 65,536 bytes. The already bounded raw documents limit the remaining structure. Exceeded limits fail the refresh without publishing truncated requirements.
- The subsequent trader checkpoint adds a shared 32 MiB conservative translated-output budget, charged before each repeated name/skill/bonus/description copy; see `2026-11-02-native-trader-catalog.md`. Per-field limits alone do not bound repeated dictionary expansion tightly enough.

## Verification and remaining work

Native/frontend/reference builds, lint, strict Rust checks and independent source review cover source integration. No tests, fixture documents, live catalog downloads, application launches or user-profile operations run. Live producer compatibility, offline/restart/query-abort behavior and runtime consumer parity remain unverified. Task/item/map/trader adaptation, broader item-condition coverage and overall Phase 6 completion remain separate work.

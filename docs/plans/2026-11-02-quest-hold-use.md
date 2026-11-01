# Holding stock and preserving use-item uncertainty

The Phase 6 review found that `haveItem` was only treated as unsupported, while `useItem` could lose all accepted IDs because its producer uses `useAny`, not the ordinary `items` field. An unrecognized objective with no adapted IDs was then ignored by requirement normalization. This can omit a real future consumable need.

## Source contract

Read-only inspection on 2026-11-02 of the provider's [quest producer](https://raw.githubusercontent.com/the-hideout/tarkov-data-manager/main/src/tarkov-data-manager/jobs/update-quests.mjs) shows `HasItem` produces `haveItem` with accepted IDs and FIR/dogtag/durability restrictions. Counter `UseItem` and flare conditions populate `useAny`; those counters become `useItem`. The counter value does not establish how many physical items remain necessary when items have charges or partial resources. Direct static-API inspection was refused (HTTP 403), so no current live catalog shape/count or game-eligibility claim is made.

## Implementation

- Add a derived Rust `hold` requirement kind. It participates in the same bounded global capacity allocator, retaining stock separately from consumptive demand. No sharing between concurrent holding goals or between holding and consumption is inferred. The plan's source explanation explicitly says the stock must stay possessed rather than be handed in. Calculating a plan never consumes inventory.
- Normalize `haveItem` with its complete count, exact alternatives, FIR, minimum dogtag level and durability constraints. Partial hand-in counters cannot reduce a possession requirement; their type eligibility remains unchanged.
- Preserve `useAny` alternatives for `useItem`. Missing source fields retain the old `item`/`items` display fallback with a review gap. Emit an explicit requirement with unknown physical quantity/FIR and a use/resource-conversion coverage gap, preventing confident surplus rather than inventing one physical unit per action. No input automation or progress inference is added.
- Validate, bound and deduplicate accepted IDs; malformed/truncated alternatives retain a gap rather than silently becoming complete. Retain raw definitions for these objective types. Preset alternatives additionally require fitted-build review: neither matching identity nor the new holding kind proves attached parts.
- Advance the shared planning-adapter marker to 2. Old cached data remains readable under the existing cache buster, but the existing freshness guards require a refresh before it can authorize surplus. No physical SQLite schema, saved inventory or partial-progress conversion changes.

## Verification and limits

Clean frontend lint, native frontend/type build, Electron frontend/main/preload, strict custom-protocol Clippy with and without staged-updates, Rust formatting and whitespace passed. The embedded native development build exited 0 in 33.88s. Independent read-only source review found no P1/P2 issue in hold capacity, use-item uncertainty, preset review or old-cache gating.

No tests, fixtures, application launches, game hand-ins/uses, profile mutations or runtime plan calculations ran. Live source compatibility and game eligibility remain unverified. Complete fitted-weapon constraints, physical use/charge conversion and broader runtime/recovery/Windows/performance gates remain open; their uncertainty is not waived by this change. Release installer not refreshed.

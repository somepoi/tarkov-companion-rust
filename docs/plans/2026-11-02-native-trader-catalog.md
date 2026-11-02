# Native trader catalog adaptation

Continue catalog ownership with typed Rust trader output. The composite game-data loader now receives trader arrays from Rust in Tauri while retaining the TypeScript reference for browser/Electron.

## Preserved view

- Trader IDs, translated/fallback names, normalized names, nullable image links and currency (RUB only when the source currency is missing/null).
- Numeric loyalty rows, stable numeric sorting, zero defaults for missing/null player-level/reputation requirements and negative reputation values. `maxLevel` remains the raw level-array length with a minimum of one, matching the reference even when nonnumeric rows are filtered.
- Restock times become epoch milliseconds for supported RFC3339 ISO timestamps. Empty, malformed, oversized, unsupported-format and leap-second values remain null. No countdown is invented from an invalid timestamp. JavaScript's broader legacy/local/date-only parsing is not reproduced or claimed compatible; live producer timestamp compatibility remains unverified.
- Existing game-data query keys, planning schema, offline copies, task-to-trader references and post-abort result checks remain. Native failures are surfaced without parser fallback. No inventory/settings migration or additional writable catalog cache is introduced.

## Admission and limits

- Main/searchbar use the existing mode/kind adapter broker and shared fixed-source base/English transport. There are now eight possible adapter jobs (items/hideout/maps/traders × regular/PvE), with 16 waiting command consumers. Actual work retains its IO lease through off-thread normalization and completed results are removed after publication.
- Typed trader output admits 512 traders, 256 raw levels per trader and 16,384 raw levels overall. IDs/normalized names/currencies are bounded to 512 UTF-8 bytes, image links to 4096 and translated names to 65,536. Duplicate IDs, malformed lists/text and nonnumeric present requirements reject refresh; unknown values are not silently converted to confirmed eligibility.
- Each completed record is charged against an 8 MiB serialized-array budget before insertion, including separator overhead. Exceeded limits fail rather than truncate the trader array.
- Source inspection also found that hideout dictionary text could be repeated across many levels/bonuses despite a per-field limit. Its translator now charges each emitted name/skill/bonus/description before allocation against a shared conservative 32 MiB budget, using six bytes per UTF-8 byte plus quotes to allow for JSON escaping. Accepted values are unchanged; expansion beyond the budget rejects the refresh. This is source-based admission reasoning, not a measured memory claim.
- Use the already locked chrono 0.4.45 parser with the core crate's `std` feature. No package versions or transitive packages change; the notice inventory/texts stay unchanged and only the embedded lockfile hash updates.

## Verification and remaining work

Frontend/reference/native builds, lint, strict Rust checks, formatting and independent source review verify integration. No tests, fixtures, simulations, live API requests, application launches or user-profile operations run. Live timestamps/producer shapes, offline/restart/overlay behavior and resource usage remain unverified. Task/objective adaptation and broader migration acceptance remain open.

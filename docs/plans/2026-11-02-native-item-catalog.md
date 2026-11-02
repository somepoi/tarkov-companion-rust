# Native item catalog adaptation and shared normalization

Continue Phase 6 catalog ownership by moving the full item adapter into `stash-core::catalog::items`, keeping the existing page-facing bundle and the browser/Electron reference.

## Item contract

- Preserve translated names/short names, normalized IDs, images/wiki links, dimensions, categories, stack maxima, price timestamps and all existing flea/trader reference prices. Trader offers retain ordering, minimum loyalty, purchase limits and quest-unlock metadata.
- Preserve player XP levels, translated category names, mode/fetch time, planning schema 2 and market eligibility/fee metadata. Unsupported flea levels, stack maxima and fee rates stay null; no default availability or fee rate is invented.
- Preserve ammo ballistics; firearm, modification and preset stats; slot filters and chamber exclusion; conflicts, preset parts and equipment images. The normalizer does not infer that a physical weapon satisfies a fitted-build requirement.
- Preserve placeholder-picture filtering and the terminal parenthesized variant/default-name rule without introducing a regex dependency. Borrow pictures from the current standard/twin entry and retain `pictureOf`; this also permits borrowing through an earlier variant, as the reference does. Map ordering for equal-name entries is not claimed to be identical across runtimes.
- Only the provider's explicit any-dogtag group gets direct alternatives. Invalid/empty/repeated/self/preset/nested/conditional members invalidate the group to null. Other items never expand into visually similar IDs or preset contents.
- The native branch returns this bundle directly. Aborted consumers reject late results; no native failure silently switches to the TypeScript adapter. Existing offline query keys/schema/timestamps remain, with source acquisition and last-good persistence separated as before.

## Shared execution and limits

- `catalog_adapters` coalesces normalization by mode and kind across main/searchbar windows. There are only four possible pending jobs: items/hideout for regular/PvE. Up to 16 command consumers can await them. Completed results are removed after publication; this is not a second permanent cache.
- Each job holds the native IO lease through fixed-source base/English reads and actual blocking adaptation. The existing transport coalesces its raw reads and applies decoded document/network bounds. Hideout now uses the same normalization broker while retaining its existing command and array response.
- Item adaptation bounds 32,768 item rows, 16,384 entries per nested list, 1,048,576 list entries overall, bounded identifiers/text and a conservative 64 MiB serialized-output accounting budget. Borrowed pictures/category text are accounted before repeated insertion; totals intentionally overcount some fields rather than omit expansion costs. Raw documents remain independently bounded. This is workload admission, not a measured peak-memory guarantee.
- Malformed identifiers/lists and duplicate item IDs reject the refresh. Numeric prices that are not numbers become unavailable, and nonnumeric dimensions reject the refresh; optional unknown facts retain the reference's null/default semantics. These stricter producer checks have not been validated against a live response.
- JSON construction and envelope adaptation remain independent of OS APIs in `stash-core`; native fetch time uses the host clock. No dependency or database schema changes are needed.

## Verification and remaining work

Frontend/reference/native compilation, lint, strict Rust checks and independent source review verify source integration. No tests, fixtures, live downloads, application launches or user-profile operations run. Live producer compatibility, offline/abort/restart/overlay behavior and measured resource use remain unverified. Task/map/trader adaptation and objective normalization still remain shared TypeScript; this is not full migration or Phase 6 completion.

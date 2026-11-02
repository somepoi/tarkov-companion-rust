# Shared native transport for static game documents

Continue Phase 6 catalog ownership after recipe normalization. Move the common `fetchJson` network path to Rust in Tauri, preserving the existing TypeScript page adapters and offline query snapshots as a separate migration step.

## Routing and ownership

- The native bridge requests only `https://json.tarkov.dev`. Accepted routes are `/endpoints`, `/status`, known regular/PvE catalog names with optional English suffixes, and `/regular|pve/prices/{bounded ASCII item ID}`. Arbitrary URLs, other modes/languages, query strings, encoded paths, traversal and unrelated endpoints are rejected. Redirects remain disabled.
- Main and searchbar windows can read these public documents. They supply no profile facts, authentication data or write destination. Catalog acquisition does not grant inventory/settings mutations to the searchbar.
- Existing item, task, trader, map, hideout, craft, translation, price-history and status consumers use the bridge through `api/client.ts` in Tauri. Browser/Electron keep their existing fetch path. Recipe planning retains its dedicated Rust normalization path.
- Page/domain adaptation remains shared TypeScript except the already migrated recipe adapter. This checkpoint does not claim that all catalog normalization or objective-to-demand conversion has moved into Rust.

## Shared work and bounds

- Concurrent consumers of the same exact route subscribe to one pending result, including main/searchbar requests. Different modes/routes remain separate. A pair of documents is still published by its existing higher-level adapter only after all required documents arrive.
- At most 16 distinct pending routes, 32 waiting command consumers and four generic HTTP/JSON workers are admitted. There is no unbounded blocking-task queue. Duplicate pending reads do not reserve another worker or native IO lease.
- A 90-second deadline covers each admitted read's queue and HTTP work; connection attempts are capped at 15 seconds. JSON parsing and response serialization remain bounded by document size rather than a hard CPU deadline. Leases remain held until real work completes, excluding staged update preparation.
- Base item documents allow 32 MiB; other documents allow 16 MiB. Both reported length and actual streamed bytes are checked. The checked-in regular-item acquisition metadata records 17,302,850 bytes, so reusing the recipe limit of 16 MiB would reject that known document. Oversize/incomplete/invalid JSON and non-success responses fail rather than truncate or publish partial data.
- Catalog clients negotiate gzip and stream automatic decompression; limits apply to decoded bytes, including when the decompressor removes the compressed Content-Length header. Binary pack/staged-installer clients explicitly disable automatic gzip so their existing identity-byte/hash contracts remain. Three compression support crates are locked and included in regenerated native dependency notices.
- Completed native results are removed after publication; the registry is not a second long-lived cache and does not assign freshness timestamps. Existing TanStack/IndexedDB persistence remains the offline source. The Rust HTTP client sends `no-cache` but currently has no stored ETag/body cache, so this does not claim the browser transport's conditional-304 bandwidth behavior.
- Query aborts discard late data/errors; a shared native read may finish for other consumers or a subsequently reopened view. There is no claim of transport cancellation. Dropped receivers, worker errors/panics and normal completion release admission, with errors propagated to subscribers. Native failures do not silently retry through the browser path.

## Verification and limits

Builds, lint, strict Rust checks, formatting and independent source review verify integration at source level. No tests, fixtures, live API requests, application launches or profile operations run. Runtime HTTP/proxy/offline/abort/coalescing behavior, current producer sizes/shapes, memory/performance and remaining native catalog adaptation remain unverified. No Phase 6 completion or measured performance claim is made.

# Native recipe catalog acquisition and validation

Phase 6 separates catalog synchronization from planner ownership. Move the existing recipe acquisition and normalization into Rust for the native application, retaining the browser/Electron reference and the current offline query store.

## Implementation

- `stash-core::catalog` owns the validated planning view of crafts and barters. It preserves source recipe/output IDs, ingredients, simultaneous-tool summation, station/trader/unlock metadata, dogtag minimum levels and explicit coverage gaps. Missing/fractional counts remain unknown. Malformed IDs, duplicate recipes or missing ingredient lists reject the document. Unknown input conditions, game-edition access and quest-item restrictions remain review gaps.
- Native `load_recipe_catalog` is main-window-only and accepts only the existing `regular`/`pve` enum. Rust requests fixed `https://json.tarkov.dev/{mode}/{crafts,barters}` routes. No caller-provided URL, request body, cookies, profile facts or arbitrary destination is accepted. Redirects are disabled; only successful HTTP responses are parsed.
- Each document is capped at 16 MiB while reading, 10,000 recipes, 256 ingredients per recipe and 65,536 ingredient rows overall. Recipe identifiers additionally reject NUL and are bounded to 512 UTF-8 bytes. Limits are deliberately conservative; an exceeded limit is a sync error, never a truncated successful catalog.
- Blocking HTTP/JSON work runs outside the UI/async runtime thread. Admission permits at most one operation per game mode, with no queue of duplicate jobs. Both HTTP reads share a 90-second deadline, with a 15-second connection limit. The native IO lease is held until actual work finishes, excluding staged update preparation.
- Frontend native requests share a pending promise per mode. Query aborts are checked before invocation and before returning either data or an error. Aborting a consumer discards its result; the bounded read may finish in the background and can be reused if that mode is reopened. This does not claim transport cancellation. No native catalog file or inventory mutation occurs.
- Both documents must download and normalize successfully before the pair is returned. Existing TanStack persistence remains the single offline copy with its original query timestamp/schema 2. A failed refresh leaves the last good copy in place and continues to surface query errors to conservative planning. There is no native fallback to a second TypeScript parser on malformed or unavailable data.
- Browser/Electron targets keep their existing TypeScript reference path. Quest/item/hideout adaptation and the objective-to-demand adapter still remain shared TypeScript; this checkpoint moves recipe sync only, not the entire catalog pipeline.

## Verification and limits

Native/frontend and reference builds, strict Rust checks and independent source review verify integration and rule preservation at source level. No tests, fixture documents, live recipe downloads, application launches or profile operations run in this checkpoint. HTTP/TLS/proxy/offline/cancellation behavior and live producer shapes remain runtime gates. No speed, memory reduction or full Phase 6 completion is claimed.

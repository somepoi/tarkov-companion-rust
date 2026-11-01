# Catalog measurement milestone implementation plan

**Goal:** Distinguish React mounting from a successful, quiescent snapshot of the default dashboard's game/item/hideout query data during isolated desktop observations.

**Architecture:** An opt-in benchmark-only query-cache subscriber observes existing queries, without initiating requests or polling. After restoration completes and all three mode-specific queries have success/idle states, it hashes their adapted JSON representations (excluding top-level local fetchedAt), rechecks immutable data identities and update timestamps, and sends a bounded summary to the host. Both hosts accept only the main isolated benchmark window and write one sibling catalog-ready.json. The incumbent process sampler records its observation time and payload separately from React readiness.

**Tech Stack:** TanStack Query, Web Crypto SHA-256, existing typed desktop adapters, Electron and Rust/Tauri.

## Tasks and acceptance

1. Define three fixed query roots, mode, bounded counts/update timestamps and SHA-256 fingerprints. Expose benchmark mode through host-controlled bootstrap metadata. No arbitrary path, source URL, inventory/player data or query payload crosses this instrumentation channel.
2. Add the benchmark-only subscriber below the query persistence provider. Avoid new query observers/fetches, intervals or production subscriptions. Hashing is measurement overhead, not scanner work. Recheck data identity, mode and fetch state after asynchronous hashing; changes invalidate the candidate. Unsubscribe on completion/unmount and discard late work.
   Require existing active queries and re-find their exact current cache objects after hashing. Process one document at a time with a 16-million-code-unit representation limit, retaining no document contents in the host summary.
3. Validate bounded summaries in each host and write once inside the same fresh isolated measurement directory as ready.json. The sampler independently retains both milestones and reports absence as null; it does not silently redefine its existing settling/sampling phases around this new signal.
4. Verify types, lint, both frontend builds, native formatting/strict Clippy/build and read-only source review. No tests, fixtures or synthetic data. Record actual verification and limitations; runtime milestone observations require a separate run, never inferred from compilation.

## Limits and rollback

Fingerprints describe exact adapted JSON byte representations with one local timestamp omitted, not canonical raw source documents. Object order, live prices, translations and source updates may change them. Counts and equal fingerprints help assess workload equivalence but do not prove equal UI/browser state, network cost, first paint or responsiveness. Missing/error/paused queries never produce a successful milestone. A new profile still has uncontrolled OS caches and network. No speedup is claimed. Revert the independent instrumentation without altering user inventory or normal application behavior.

## Implementation evidence

Implemented the benchmark-only subscriber, bounded summaries, host metadata/validation and atomic one-shot publication, plus the sampler's independent catalogReadySignal. Review found stale captured Query identity and incomplete/concurrent publication risks; exact current-cache identity checks, active-query guards, atomic publication and a native publication mutex resolved them. Follow-up independent review found no remaining P1/P2 issues in those fixes.

On 2026-10-30 TypeScript, lint, both frontend builds, strict custom-protocol Clippy, Rust formatting, native embedded development build and syntax/whitespace checks passed. Actual isolated Electron and native development observations then produced both milestones and matching public catalog fingerprints. See [raw evidence and limits](../performance/2026-10-30/catalog-milestone/README.md). No tests, synthetic inputs, screenshots or game interaction were used. This does not complete release baseline or optimization acceptance.

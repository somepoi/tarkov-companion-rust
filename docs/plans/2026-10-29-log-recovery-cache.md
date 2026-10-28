# Native log recovery and completed-session cache

**Goal:** Restore live watching after the selected log root is removed/recreated, and reuse parsed unchanged completed sessions during repeated backfill/Stats reads.

**Architecture:** Preserve the shared interpreter and explicit pull/ack transport. Rust watches the selected root recursively and a bounded nearest existing ancestor nonrecursively. Reconcile scope on notifications, resetting the epoch/cursors when the canonical root or root creation changes. Missing roots remain visible; unrelated sibling events are filtered. Paused/benchmark mode starts no watcher. Watcher failure is explicit, with bounded restart attempts rather than polling.

History emits per-session begin/end descriptors containing native root identity and sorted recognized-file metadata. The worker holds a bounded in-memory cache of raw interpreted historical events and session span, keyed by scope, parser version and metadata. It can request skipping unchanged completed sessions; Rust still validates the descriptor before skipping. The newest session is never cached. Verify metadata again after parsing; cache only successful complete sessions. Aggregate profile/reset reductions always rerun over the current selected history, including cache hits. Cancellation/failed/changed sessions never produce a partial successful result. The cache is disposable and not user inventory authority; no new disk persistence or filesystem writes are required.

1. Add parent/root watch reconciliation, bounded error recovery, scope generation/cursor reset and source documentation.
2. Add bounded session signature descriptors and explicit begin/skip/end acknowledgements to historical transport; enforce root/metadata consistency.
3. Add worker cache admission/eviction and per-session immutable event/span reuse; update protocol/bridge and keep final reducer authoritative.
4. Review source and run formatting, TypeScript, lint, both frontend builds and native compilation/Clippy. Do not create/run tests or read real game files. Record runtime/metadata limitations and commit with current Git identity.

Metadata signatures detect ordinary changes, not adversarial same-size/same-time rewriting. This matches the incumbent cache trust level and is not a cryptographic archive integrity claim. Actual notify recreation, locked-file races and measured resource savings remain runtime gates.

## Implementation checkpoint

Implemented ancestor/root watches, canonical/creation epoch reconciliation, Windows component case matching and aliases for missing suffixes. Sync/async watch faults share a three-errors-per-minute rearm bound; the third failure stops with an explicit reconnect message. Transport failures permit notification-triggered retries, including notifications queued during an error, while parser failures remain explicit. Paused history retains its root without starting watches; benchmark mode bypasses game paths.

History now uses begin/skip/end acknowledgements. Native signatures bind scope, creation/mtime/length/sorted recognized files and a format/application version. A completed session is validated around cursor admission, skip and completion. The current session remains an uncached snapshot; truncation below the snapshot boundary is rejected. The worker keeps raw events and spans with LRU bounds (128 sessions, 50000 events, four million serialized UTF-16 code units). It always reruns the shared final profile/reset reducer and never returns an unfinished aggregate as success. The cache is process-memory-only, matching the incumbent cache lifecycle.

Read-only review found notification/fault ordering, Windows path-case filtering and async watch-rearm gaps; those were addressed, including a second ordering race for notifications arriving during cleanup revocation. Follow-up review reported no remaining P1/P2 issue in the fixes. TypeScript, lint, both frontend builds, Rust formatting, strict custom-protocol Clippy and the embedded native development build passed. No tests, fixtures, actual log reads, watcher runtime exercise or performance measurements were performed.

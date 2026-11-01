# Preserve offline catalog writes and report storage failures

The audit and migration plan require last-known offline catalogs to survive ordinary upgrades and storage failures. Source inspection found three concrete problems in the shared persister: a failed IndexedDB write was silently treated as saved for signature deduplication; removal did not wait for earlier writes, allowing them to restore a cleared key; and the nominally read-only searchbar restore deleted the legacy key. Settings additionally cleared in-memory queries before deleting storage, suppressed deletion failures and always reported success.

## Implementation

Keep the existing schema, cache key, 30-day age policy, live-query exclusions and five-second coalescing. Serialize writes and explicit removal. A generation invalidates queued pre-clear jobs, while an already-running write completes before deletion. Cancel pending timers on removal and suppress persistence during the removal barrier. After successful deletion, Settings resets queries so active observers can refetch; failure keeps the in-memory queries and displays the reason.

Retain the latest failed write in memory for an explicit retry or a later hide/leave flush. Newer catalog snapshots supersede older failed ones. Storage failures are observable through a small subscription used by Settings, with a retry button when a snapshot is available. No polling, background retry loop, catalog refetch or cache deletion is triggered by the retry action. A successful write clears the error. Losing the process can still lose pending unsaved data; pagehide is a best-effort asynchronous flush, not a power-loss guarantee.

Restore validates persistence-envelope metadata before signature construction. It does not claim full runtime catalog schema validation. Legacy string-format copies are ignored during restoration and removed only through the writer's removal path (including TanStack's existing invalidation policy); read-only searchbar restore performs no writes. An obsolete asynchronous restore cannot update the writer's signature across a removal or newer pending work.

## Verification and limits

TypeScript/native frontend build and lint passed. Independent read-only source review found no P1/P2 issue in write/removal ordering, generations, retry ownership, read-only restoration or clear/reset behavior. Electron frontend/main/preload and embedded native development builds passed; after a final clear-versus-reload error-copy refinement, native frontend/type checking/lint and embedded native development build passed again (23.11s). Whitespace checks passed. No native Rust modules or dependency graph were changed.

No tests were created or run. No storage-failure simulation, actual cache removal, application launch or user-data operation ran. Browser storage availability, quota failure, restart/offline behavior and the wider native runtime/parity gates remain unverified. This change preserves existing adapted catalogs and does not close unrelated planner/state/accuracy or signed-release requirements.

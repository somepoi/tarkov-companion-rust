# Reported inventory changes and outdated snapshots

Phase 7 requires cross-container transfers after an old scan to be explicitly reconciled or marked stale. Implement the latter: the user reports affected containers after moving, using, selling or rearranging items. There is no automatic inference of transfers from matching catalog IDs and no game interaction.

## Persistent facts

- Schema 9 adds nullable `snapshots.stale_reason` and a profile-scoped invalidation replay table. Existing snapshots remain unchanged. The normal backup-before-migration path applies; older binaries reject the newer schema. Read-only backup validation for schemas 1–8 does not select the new column.
- `invalidateInventory` accepts a profile, 1–256 selected container IDs with expected revisions, a bounded reason and an idempotency key. One immediate transaction checks all selected heads/profile membership before writing any replacements. Matching replay is checked before revisions; key reuse with different input fails. Failure rolls back the entire selection.
- Each scanned container gets a new revision containing its historical stacks, capture metadata and evidence references, false full coverage and the reported reason. Never-scanned selections remain unknown without inventing a verified empty snapshot. The response lists only the heads actually replaced.
- Old scan sessions cannot commit over the changed revision. A new reviewed full scan clears staleness. Partial patches preserve the baseline stale reason, even for newly reviewed regions. Undo preserves staleness from either the current or restored snapshot; it cannot turn a reported physical change back into trusted stock.

## Consumers

- The Stash Manager exposes a multi-container selection, explicitly asks for both transfer endpoints and shows the reason beside each outdated head. It disables invalidation while editing a scan draft or another stash operation is running. Existing draft save/discard paths remain available.
- Historical stale stacks remain visible/exportable but are excluded from the page's confirmed totals and Rust planner allocation/confirmed-owned counts. Planner output explains the need for a new full scan; stale stock yields REVIEW, and incomplete coverage blocks surplus decisions. Existing never-sell protection remains explicit.
- Inventory JSON carries the optional reason. CSV appends `snapshot_stale_reason` to container and physical-stack rows, leaving legacy rows blank. Formula escaping, size limits, separate legacy counts and full backup evidence remain unchanged.

## Verification and limits

Source review and compilation cover the implementation paths; no tests, sample databases, game actions or profile mutations are created/run. Actual migration, restart, invalidation/replay, partial/undo/rescan workflows remain runtime acceptance gates. This action records changes reported by the user; unreported physical changes cannot be detected from old screenshots.

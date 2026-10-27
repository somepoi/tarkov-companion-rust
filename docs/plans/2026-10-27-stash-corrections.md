# Stash identity review and learned appearances

The full-container reviewer reuses the incumbent scanner's learned-reference store and matcher. It does not introduce a second recognizer or infer quantity/FIR from a chosen identity.

## Behavior

- Expand one stack to inspect its archived screenshot footprint, original candidates and raw match error. Search the catalog to replace the identity, or explicitly leave it unknown.
- Changing an identity clears its identity confirmation. Quantity, FIR, position and dimensions remain separate editable facts. The user checks the footprint rather than silently resizing it to catalog dimensions.
- Moving or resizing a footprint clears identity/quantity confirmation and resets FIR to unknown, because the edited region may contain a different physical stack. Learning requires confirmation of the current region.
- Remembering an appearance requires an explicitly confirmed identity and a complete registered screenshot footprint. It is a separate action from saving inventory. Repeated learning from the same screenshot/grid/footprint/item replaces the same reference.
- Learning writes to the existing bounded IndexedDB correction store. The explicit action rejects read/write failures, serializes writes and reports success only after the write completes. Existing reference retention limits still apply. Full native backups already include this store; Item Collection's correction panel can inspect/export/remove the records.
- Learned matches remain unconfirmed when imported into the next stash draft. Training does not authorize SELL, confirm amounts/FIR or alter accepted container snapshots.

## Evidence and storage

Schema 3 permits optional `sourceGrid` metadata in each immutable recognition observation. It records the scanner's pixel pitch/origin and grid dimensions against the screenshot hash. Existing drafts omit this field and remain readable; they support identity correction but need a new import before appearance learning. Schema 3 has no destructive SQL conversion. The existing SQLite-API pre-migration backup runs before the version changes. Older binaries reject the newer schema rather than failing while parsing observation JSON.

The main window reads archived evidence through a hash-only native command. It checks canonical scope, reads at most 64 MiB plus an overflow sentinel, verifies SHA-256 and returns binary bytes. No arbitrary paths or game process access are exposed. Only one expanded reviewer retains evidence; closing it revokes its object URL and ignores late asynchronous results.

The shared crop function refuses nonfinite geometry, clipped/out-of-grid footprints and references exceeding the backup contract's 256-cell / 512-KiB-thumbnail limits. It closes image bitmaps after use.

## Verification boundary

No tests or real screenshot recognition checks are authorized for this implementation. Type checking, frontend builds, lint, strict Rust Clippy and an embedded native development build establish compilation, not recognition accuracy, restart durability or a completed six-container workflow. Runtime and corpus gates remain open in the execution ledger.

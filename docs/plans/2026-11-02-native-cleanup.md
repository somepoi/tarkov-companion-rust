# Native manual leftover cleanup

The migration plan requires preserving desktop cleanup without touching the original application or personal data. The previous checkpoint merely explained that the native implementation was unavailable. This change implements manual discovery/confirmation through the existing desktop adapter contract.

## Target and confirmation rules

- Discover only exact older stable-version fork installer/portable names in the native Downloads directory, and exact generated native `scan`/`lighthouse` pack or abandoned staging directory names in this profile's pack root. Retain equal/newer installers and the running executable. Original application names do not match.
- Retain every compiled-current pack hash and every pack directory currently held in the native installed map. Serialize cleanup with pack installation and exclude it from staged update preparation through the existing native IO gate. No updater payload/recovery directories, browser caches, crash stores, database, screenshots, settings, backups or user-selected arbitrary paths are targets.
- Preview builds a native-owned, two-minute, one-use plan. Confirmation uses only that plan, rather than rescanning and silently adding newly discovered files. Main-window dispatch validates exact arguments; the searchbar cannot inspect or confirm cleanup. Measurement mode refuses cleanup.
- Before recycling, require the same canonical direct-child scope, parent identity, target/tree file identities, timestamps, sizes and attributes as the preview. Reject symlinks, reparse points and hard-linked regular files. Recursive inspection is bounded by depth, count and elapsed time; incomplete candidates are retained with diagnostics. These are metadata identities, not content checksums or a malware boundary against another process running as the same user.
- Both confirmation and the final Shell pre-operation callback recheck the snapshot. Use the existing Windows recycle-only COM operation, now shared with position-shot recycling; do not permanently delete or fall back to permanent deletion. Only disappeared successfully processed targets count as removed. Partial failures and changed targets appear in warnings; already completed operations are not rolled back.

The native UI now enables Clean up now with precise scope, supports checking again (including empty/expired previews), displays retained/failed-target warnings and catches last-result errors. Automatic post-update cleanup remains off. The last manual result is process-local; it is not presented as a persisted automatic cleanup receipt.

## Verification

No tests, fixture generation, application launches or cleanup operations were run. Source review covered namespace matching, current-pack protection, native preview consumption/expiry, root/tree identity checks, partial outcomes and lease lifetimes. Initial verification found and corrected a moved import before module documentation. A separate embedding check overlapped frontend output replacement; after the frontend completed, the native static check passed. Final static/build evidence is recorded in the execution ledger.

Final checks: frontend lint, TypeScript/native production frontend, Electron frontend/main/preload, strict custom-protocol Clippy with and without staged-updates, formatting, local documentation links and whitespace passed. The final embedded native development build exited 0 in 26.79s. Independent source-only review found no P1/P2 issues in the scope/preview/identity/lease paths or extracted recycle helper.

Runtime Recycle Bin behavior, cancellation/failure presentation, Windows compatibility and the broader migration gates remain unverified. Active WebView caches, crash cleanup and automatic post-update cleanup remain separate follow-ups, not silently claimed as migrated. The older release installer has not been refreshed by this task.

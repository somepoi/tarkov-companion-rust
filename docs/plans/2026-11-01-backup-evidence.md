# Snapshot-bound backup evidence plan

Goal: preserve all saved screenshot evidence belonging to the transactional database snapshot, without importing unrelated live archive files into that snapshot's backup.

The current create path snapshots SQLite, then enumerates every live screenshot file. Instead, use the incumbent read-only database verifier to derive the snapshot's complete evidence hash set, then copy exactly those files. Include the separate scan_observations table as well as snapshot stacks, saved drafts and compositions; malformed references or missing/corrupt referenced files must fail the backup. Never delete or modify source images. Unsaved edits and images not referenced by saved facts are outside the full saved-state backup.

Implementation: extend Repository::verify_file to collect independent saved observation references; derive evidence from the newly created SQLite snapshot before copying; enforce existing entry/total limits before copy and retain post-copy checksum validation and final bundle verification. Preserve old bundle compatibility: imported older backups may still include additional images. No schema or manifest version change is needed.

Verification: Rust formatting, strict custom-protocol Clippy, native build and independent source review. Do not create or run tests, fixtures, screenshot workflows or restore exercises. Runtime recovery acceptance stays open. Reverting this focused change does not affect live inventory schemas or source archives.

Implementation: snapshot verification now collects independent scan_observations records in addition to all historical stacks, drafts and compositions, including joined-source metadata. Backup creation copies only that snapshot's evidence set, checks entry counts and advertised sizes before copy, and retains checksum/actual-size/final manifest checks. Older bundles with additional image entries remain accepted by the existing verifier. Source archives are never pruned by this change.

Verification on 2026-11-01: strict workspace/custom-protocol Clippy, Rust formatting, whitespace checks and the embedded native development build exited 0 (build 44.55s). No tests, fixtures, real image processing, actual backup/restore or migration lifecycle ran. This is source/build evidence, not proof of recovery lifecycle acceptance or a measured performance improvement.

## Streaming-budget follow-up plan

Metadata checks alone do not bound IO when a source grows after inspection: the original shared reader allowed every entry to grow to 1 GiB, even for a 64-MiB image or a tiny declared manifest entry. Pass an explicit per-call budget to the streaming reader, capped by the global entry limit. Read at most remaining budget plus one detection byte; reject before hashing/writing overflow bytes. Creation uses the observed image size (already constrained by screenshot and remaining bundle limits); verification/restoration uses declared entry bytes, activation uses the screenshot cap, and staged JSON uses the JSON cap. Keep actual size/checksum checks and incomplete staging behavior. No source deletion or bundle format change. Verify formatting, strict Clippy, native build and source review without tests or simulated changing files.

Follow-up implemented 2026-11-01. Strict workspace/custom-protocol Clippy, formatting and whitespace checks exited 0; embedded native development build exited 0 in 23.65s. Independent source review found no P1/P2 issues. No tests, synthetic growth/EOF cases, files modified during copying, actual backup/restore, screenshots or game integrations were exercised. Failed staging files remain incomplete as before; this change does not add automatic cleanup or claim a total disk-space guarantee for SQLite snapshot creation.

## Backup progress follow-up

Implemented 2026-11-01: the serialized native backup job emits window-scoped progress events. File hashing/copying reports current-file bytes with a 150 ms throttle; database snapshot, saved-reference verification and recovery preparation show indeterminate stages. The UI subscribes before invoking and unsubscribes when the operation settles. Progress never includes filesystem paths and is explicitly per file rather than a whole-job completion estimate. Failure/success continues to come from the command result. No bundle/schema changes.

Verification: Tauri frontend typecheck/build, oxlint, workspace Clippy and custom-protocol Clippy with warnings denied, Rust formatting and whitespace checks passed. No tests or actual backup/restore/game capture were run. Runtime event delivery and recovery acceptance remain unverified.

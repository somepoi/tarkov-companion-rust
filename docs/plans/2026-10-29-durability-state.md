# Physical durability facts and constrained allocation

Continue Phase 6 with an independent manually confirmed durability percentage. Neither icon matching nor quantity recognition establishes condition.

1. Add optional `{percent, confirmed}` physical durability fact to stack JSON and schema 7, with a pre-migration SQLite backup. Accept finite 0..100 percentages only; old rows remain unknown.
2. Normalize complete integer quest ranges within 0..100. An explicit 0..100 range imposes no restriction. Malformed, partial or inverted ranges remain coverage gaps. Keep weapon build/fitted-parts and other unsupported conditions blocked.
3. Native allocation checks inclusive minimum/maximum bounds alongside FIR/dogtag. Unknown applicable state adds one bounded gap per stack; a confirmed out-of-range item cannot meet that requirement. Reusable tools require equal state restrictions before sharing.
4. Add manual entry and separate confirmation, clear facts on identity/footprint changes and withdraw state confirmation when identity confirmation is withdrawn. New detections remain unknown. Do not calculate a percentage from an ambiguous denominator or assume a catalog maximum is the physical item's current maximum.
5. Preserve facts through source composition/partial retention/backup/JSON and add explicit CSV fields. Include range explanations in requirement sources.
6. Verify types/lint, UI builds, strict native Clippy/format, native embedded build and read-only review. Do not create/run tests or use real screenshots, as instructed.

Primary source read 2026-10-29: tarkov.dev's own UI `src/modules/task-elements.mjs` renders min/max durability as percentages and displays restrictions for minimum > 0 / maximum < 100: https://github.com/the-hideout/tarkov-dev/blob/main/src/modules/task-elements.mjs . Its producer copies game objective min/max values directly and emits 0/100 defaults for unrestricted objectives: https://github.com/the-hideout/tarkov-data-manager/blob/main/src/tarkov-data-manager/jobs/update-quests.mjs . This establishes the source contract; runtime game eligibility is not verified.

Rollback: use the prior schema-6 backup with the matching old binary. New schema data must not be opened by older binaries. No downgrade, publication or game input automation.

Implementation checkpoint: schema 7 is connected to the existing SQLite backup-before-migration path. Physical facts remain optional in snapshots/source drafts and are copied only when retaining the same selected physical source or unseen baseline footprint. New detections do not inherit them. Shared native validation rejects nonfinite/out-of-range state or confirmation without a reviewed identity. The allocator independently checks inclusive range eligibility; absent applicable confirmation blocks reliable surplus decisions. Complete 0..100 ranges normalize to no restriction, while partial/malformed ranges remain gaps. Requirement explanations show percentages, and fallback objective progress signatures now include both dogtag and durability constraints so changed conditions cannot silently reuse prior hand-in counters.

Manual UI entry makes no inference about current/original maximum durability or armor plates. Users explicitly verify the percentage against the quest condition; unsupported build/plate-specific/other requirements still require review. CSV now has 30 columns, including blank unknown percentages and independent confirmation flags; JSON and full recovery retain the optional source facts.

TypeScript, lint, both frontend builds, strict custom-protocol Clippy, Rust formatting, embedded native development build and whitespace checks passed. UI source detector returned no findings; separate read-only review, including the objective counter signature follow-up, found no concrete P1/P2 issue. No tests, screenshots, actual game eligibility, migration/restart/recovery or runtime UI workflows were exercised.

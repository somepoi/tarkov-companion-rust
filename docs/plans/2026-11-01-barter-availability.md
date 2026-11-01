# Current barter availability implementation plan

Goal: distinguish selected future batches from exchanges the user has explicitly checked as available now. Public buyLimit/restockAmount values do not establish current personal stock or remaining transactions, and are not converted into a transaction count.

Add optional session-only per-recipe availability facts (bounded whole exchange count and separate confirmation). Selected barter demand remains unchanged; absent, unconfirmed, invalid or insufficient current availability adds a coverage gap and prevents complete sale advice. Existing quest, loyalty, catalog and physical-state checks remain independent. Zero planned batches need no availability fact.

Show the controls below each selected positive barter row. Editing count withdraws confirmation. Blur and inventory changes withdraw all availability confirmations; wipe clears values, profile remount discards them. Include facts in normalization and the explicit plan signature so obsolete results disappear. Do not persist these short-lived facts, infer stock from the catalog or automate exchanges. Future plans keep their ingredient reserves even while unavailable.

Bind effective confirmation to recipes.dataUpdatedAt so a refreshed catalog immediately invalidates old availability without a state-setting effect. Controls and normalization share this derived validity. A confirmation is a user's observation at that moment, not a live stock feed or guarantee against subsequent server/game changes.

Verify types, lint, both frontend builds, embedded native build, source UI/whitespace checks and independent review. No tests, synthetic availability cases, screenshots or actual trades. Runtime controls/focus/profile flows and complete trade eligibility remain unverified.

Implementation completed 2026-11-01. TypeScript, clean lint, both production frontend builds, embedded native development build (26.53s), UI source detector and whitespace checks passed. A lint warning from the first catalog-refresh effect was resolved by the timestamp-bound derived validity above. Independent source review found no P1/P2 findings. No tests, fixtures, runtime focus/wipe/catalog refresh workflow, screenshots or actual trades were exercised. Installer artifacts were not rebuilt for this source checkpoint; full trade/runtime acceptance remains open.

# Barter dogtag conditions implementation plan

**Goal:** Connect source-defined barter dogtag level restrictions and the provider's any-dogtag group to existing confirmed physical dogtag facts without weakening unsupported-condition handling.

**Architecture:** Keep the native constrained allocator and schema 8 unchanged. Parse `attributes.minLevel` into the existing optional minimum dogtag level. Retain a bounded, explicitly validated alternative list only for the JSON provider's `customdogtags12345678910` group. Resolve this group for quest and recipe demands; ordinary item and weapon-preset IDs remain exact. Unknown/malformed group data or conditions add coverage gaps and cannot authorize SELL.

**Tech Stack:** Existing TypeScript catalog adapters, React planner and Rust requirement contract.

## Evidence and decisions

Read the actual PvE and regular `/barters` documents on 2026-10-30: each contained 892 recipes, including `requiredItems[].attributes.minLevel`. Read the live `/pve/items` group: it explicitly lists concrete dogtag variants under `containsItems` with count 1 and empty attributes. This list is alternatives for this named provider group, not a physical preset to disassemble. Do not infer faction aliases from pictures, translated names or edition suffixes.

Primary producer sources inspected:

- https://raw.githubusercontent.com/the-hideout/tarkov-data-manager/main/src/tarkov-data-manager/jobs/update-barters.mjs creates minLevel attributes from dogtag requirements.
- https://raw.githubusercontent.com/the-hideout/tarkov-data-manager/main/src/tarkov-data-manager/modules/remote-data.mjs defines source dogtag groups.
- https://raw.githubusercontent.com/the-hideout/tarkov-data-manager/main/src/tarkov-data-manager/modules/dogtags.mjs identifies the ordinary BEAR/USEC tags.
- https://json.tarkov.dev/pve/barters and https://json.tarkov.dev/pve/items are current data evidence, not accuracy or game-eligibility verification.

The source already has native minimum-level validation/allocation, independently confirmed Stack dogtag facts, immutable snapshots, and a global alternative allocator. Reusing them avoids a second allocation algorithm. No new persisted inventory fields or database migration is necessary.

## Tasks

1. Add the narrow provider-group adapter and resolver. Require 1..256 unique direct members, exact count 1, empty explicit attribute objects, valid known IDs and no nested preset/group. Missing or malformed membership stays unknown, never an empty accepted set that releases stock. Retain optional metadata so older cached catalogs remain usable with explicit gaps when group expansion is needed.
2. Parse bounded integral minLevel 0..1000 on barter inputs; positive values use the existing native minimumDogtagLevel field. Preserve unknown attributes and malformed values as gaps. Retain metadata versioning for cached recipe catalogs so pre-change recipe data cannot omit restrictions silently.
   Add scoped planning metadata versions to item/quest catalogs as well. Older offline data stays visible, but the planner requires refreshed condition metadata; query observers consider older adapters stale without deleting the whole persisted cache.
3. Resolve accepted items for quest and selected recipe requirements. Preserve one demand/quantity for a group, not one count per member. Describe minimum levels in requirement explanations. Craft tools retain their current sequential semantics; unsupported craft minLevel remains a gap.
4. Verify TypeScript, lint, both production frontend builds, embedded native build, formatting/whitespace and read-only source review. Do not create or run tests, synthetic examples, screenshot checks or game workflows. Record actual results and remaining limitations, then commit with current Git identity.

## Acceptance and limits

A selected supported barter with a positive level threshold reaches native allocation with that threshold, so low confirmed levels cannot satisfy it and unknown applicable levels retain REVIEW. Any-dogtag accepted variants come only from the validated provider group, with the same total demand shared globally against competing exact item demands. Missing membership, unknown input conditions, unsafe counts or old recipe metadata retain coverage gaps. Generic group identity alone is not confirmation of a concrete physical tag.

This does not prove barter unlocks, restock capacity, faction/edition aliases absent from source membership, actual game acceptance or screenshot recognition. Weapon-build and other physical-state restrictions remain separate open work. Rollback reverts catalog/requirement adapters; native inventory data stays compatible.

## Implementation checkpoint

Implemented the bounded group adapter/resolver, barter level propagation, shared quest/recipe alternative resolution and scoped item/quest/recipe adapter versions. Unknown old catalogs stay readable and are considered stale for normal refetch; planning remains blocked until condition metadata is current. Group resolution retains one quantity and native global competition across accepted IDs. An unresolved generic physical stack or active manual group reserve explicitly blocks surplus; manual reserves continue to use concrete variants. Native inventory schema and physical facts were unchanged.

Verification completed on 2026-10-30: `npx tsc -b`, `npm run lint`, `npm run build:desktop`, final `npm run build:tauri-ui`, and `node scripts/native.mjs cargo build --locked -p tarkov-companion-rust --features custom-protocol` all exited 0. The final native build embeds the rebuilt frontend and uses the development profile; it is not a new release-performance observation. UI source detector returned no findings, whitespace checks passed, and independent read-only source review plus the manual-reserve follow-up found no P1/P2 issue.

No tests, synthetic cases, fixtures, game screenshots, actual barter/hand-in, restart/upgrade/cache recovery or interactive application workflow were exercised. Live source-document inspection establishes the producer format, not in-game acceptance or allocator correctness under every input. Phase 6 remains open for weapon builds, other states and actual trade eligibility.

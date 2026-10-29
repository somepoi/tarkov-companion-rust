# Physical dogtag level facts

Extend Phase 6 with independent manual dogtag level facts, not inferred from icon identity or OCR. The API's `dogTagLevel` requirement is retained as a minimum level; faction/edition alternatives remain the source catalog's exact item IDs.

Implementation steps:

1. Schema 6 introduces optional bounded `{level, confirmed}` dogtag facts in stack JSON. Old stacks remain unknown. Back up before migration and reject opening with older binaries.
2. Add optional minimum dogtag level to normalized quest/native requirements. Zero is no level restriction; invalid values remain coverage gaps. Durability/build restrictions remain unsupported and block SELL.
3. Permit flow edges only from confirmed sufficient levels when a demand is constrained. Unknown levels on candidate stock generate a coverage gap; low confirmed levels cannot satisfy the requirement. Sequential reusable groups must share identical constraints.
4. Provide manual level entry and separate confirmation in stack review. Invalidate the fact on identity or footprint changes; every new recognition starts unknown. Saved source views and retained baseline stacks preserve their existing facts without copying them to new detections.
5. Include facts in exports/recovery and explanatory allocation source text. Keep stock quantities, FIR and item identity confirmations independent.
6. Verify types/lint, both UI builds, strict native Clippy/formatting, embedded application build and separate source review. No tests or screenshot checks, per user instructions.

Source inspected 2026-10-29: https://tarkov.dev/api/ and https://raw.githubusercontent.com/the-hideout/tarkov-api/main/schema-static.mjs (`TaskObjectiveItem.dogTagLevel`); read-only current https://json.tarkov.dev/pve/tasks contains level-20 requirements with explicit alternative IDs and zero defaults elsewhere. No player/game state was accessed. Level comparison follows the source's minimum-level meaning; this is not a measured runtime acceptance claim.

Rollback: prior schema-5 database backup or a compatible newer binary; never open new JSON shapes with an older binary. No automatic downgrade or release publication.

Implementation checkpoint: schema 6 is connected to the existing pre-migration SQLite backup path. Optional dogtag facts survive stack JSON, source-view composition, partial-patch retention, JSON reporting and full recovery payloads. CSV has two additional columns with blank levels and independent confirmation flags for unknown/legacy rows. Manual changes to identity/footprint clear the fact; withdrawing identity confirmation withdraws level confirmation. New recognition never copies old tag facts.

The native flow checks minimum level alongside FIR; unknown applicable facts add at most one gap per physical stack. Confirmed low levels cannot satisfy constrained requirements. Reusable groups reject different state constraints. The 1..1000 accepted range is an input bound, not a claim about the game's maximum player level. Raw zero dogtag thresholds do not impose a level requirement. Existing durability gaps are intentionally retained, including current source default 0/100 fields, until their applicability/semantics are handled explicitly.

TypeScript, lint, both frontend builds, strict custom-protocol Clippy, formatting, embedded native development build and whitespace checks passed. Source UI detector returned no findings; separate read-only review found no concrete P1/P2 issue. No tests, screenshots, real inventories, migration/restart/recovery exercise or in-game eligibility verification were performed.

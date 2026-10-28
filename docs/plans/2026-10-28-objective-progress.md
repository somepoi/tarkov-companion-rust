# Partial consuming-objective progress

**Goal:** Reserve remaining quest materials after explicitly recorded hand-ins/placements/sales, while preserving the existing per-mode quest store and invalidating stale stock advice.

**Architecture:** Extend the incumbent `Profile` with optional, validated task/objective counters. Do not infer counters from Item Collection, completed-task deductions or logs that only report whole-task states. Normalize consuming objectives once and reuse their remaining amount in both legacy needs and the physical planner. Keep physical stock unchanged; require renewed inventory freshness confirmation after progression changes.

## Facts and scope

- A counter records completed quantity, expected total, source-definition signature, manual confirmation time and current/review status. Only supported consuming objectives (`giveItem`, `plantItem`, `sellItem`, `mark`) qualify. All accepted item alternatives share one counter; subtract it once.
- Recording current progress requires an explicitly active, unfinished, nonfailed quest, a known nonnegative integer total and a manual confirmation against the game. Missing/invalid totals do not become one. Unknown/unstructured conditions remain coverage gaps.
- Include the complete raw objective definition in normalization so changing state restrictions/quantities invalidates old counters even if display labels are unchanged. Use canonical key ordering. Definition mismatch, inactive/failed state or review status retains full demand and reports a gap; never clamp an obsolete counter downward and release reserves.
- Active-state transitions/failure invalidate old counters without deleting them. Wipe/reset clears counters with the existing profile reset and preserves the pre-reset archive. Wiki task-ID migration retains old counters for review rather than silently crediting a different objective.
- Imports validate all facts before replacing progress; missing optional fields in older exports mean no known partial progress. Hydration retains unrecognized partial data separately for recovery and blocks SELL until reviewed/cleared. Existing export/daily/full-backup paths carry the optional fields.
- The editor shows current versus saved definition, remaining amount and stale-edit/review states. Save uses the explicit mode and current fact token, not whichever mode is selected after an asynchronous step. The incumbent localStorage cross-window model remains the authority; it is not a new SQLite quest tracker or a cross-window transactional guarantee.
- Player/quest/objective/hideout changes participate in the planner's progression revision and invalidate freshness. A recorded hand-in does not remove stock from a container snapshot. The UI explains that the user must update inventory after consuming items before confirming current stock again.

## Files and execution

1. Add typed validation/definition/remaining-counter helpers in `src/lib/objectiveProgress.ts`; add optional raw definition metadata during API normalization.
2. Extend `src/store/progress.ts` persistence/import/export/actions and update wipe reset. Preserve backwards-compatible optional profile fields and retain invalid source data for review.
3. Apply remaining consuming quantities in `src/inventory/requirements.ts` and `src/lib/needs.ts`/`useNeeds`, with no second subtraction across alternatives. Preserve source/reason and completeness gaps.
4. Add a focused inline editor under existing planning UI, search/limit visible tasks and use the incumbent quest-active controls. Include counters/statuses in progression revision and invalidation.
5. Typecheck/lint/build both frontends and the embedded native build; read-only source review. No tests, fixtures, real screenshot checks or game/process access. Record source implementation and runtime limitations; commit with the existing Git identity.

## Implementation checkpoint

Implemented the helper, optional profile facts and recovery data, import/export, lifecycle invalidation, remaining requirements, legacy needs and inline editor. Read-only review found no P1/P2 issues. TypeScript, lint and both frontend production builds passed. The native host is unchanged by this feature; a fresh embedded native build is being performed with the separate pack integration. No tests were created or run. Manual editor/restart/import behavior and real game correctness remain runtime-unverified; screenshot verification was explicitly skipped by the user.

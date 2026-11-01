# Selected recipe access conditions

Goal: preserve selected future ingredient reserves while exposing missing quest unlocks and unconfirmed barter loyalty instead of silently ignoring them.

Live [PvE crafts](https://json.tarkov.dev/pve/crafts) and [barters](https://json.tarkov.dev/pve/barters) source documents inspected 2026-11-01 expose craft taskUnlock (omitted when unrestricted), gameEditions, station/level; barters expose trader, taskUnlock, minTraderLevel, buyLimit/restockAmount. Parse unlock/loyalty conditions and retain malformed values as gaps. Nonempty or malformed edition restrictions remain unsupported gaps. Increment the scoped recipe adapter version so older cached recipes cannot silently omit these conditions.

Reuse recorded quest completions and current hideout facts. Add optional session-only explicitly confirmed trader loyalty inputs for selected barters, never infer it from player level, reputation or quest completion. Editing invalidates confirmation; remount/profile change discards the inputs. Include them in requirement memo/signature so old advice disappears. Unknown/missing trader metadata, missing unlock tasks and insufficient/unconfirmed loyalty create coverage gaps without dropping selected ingredient demand. UI uses existing controls and documents that future planning is allowed but access is not guaranteed.

No new persisted schema or automatic trade action. Stock, buy limits, restocks, bans and edition access are not proven; full trade eligibility remains open. Verify types, lint, both production frontend builds, embedded native build, whitespace/UI source checks and independent review. Do not create or run tests, synthetic recipes, screenshots or actual trades.

## Implementation evidence

Recipe adapter schema 2 retains explicit quest unlocks and barter trader/minimum loyalty. Selected recipes retain ingredient demand while adding access coverage gaps. Session-only loyalty controls appear only for traders used by selected barters; levels are bounded by available catalog metadata, editing withdraws confirmation, wipe clears the session inputs and profile remount discards them. Explicit fact values are part of the UI plan signature. No player-level inference or persisted character-loyalty fact was introduced.

On 2026-11-01 TypeScript, lint, both production frontend builds, embedded native development build (37.37s), whitespace and UI source checks passed. No tests, synthetic cases, actual trades, screenshots, interactive controls, mode/profile switching or wipe workflow were exercised. Current installer artifacts predate this source checkpoint and were not rebuilt for this frontend change. Source/build checks do not prove complete recipe eligibility or runtime UI acceptance.

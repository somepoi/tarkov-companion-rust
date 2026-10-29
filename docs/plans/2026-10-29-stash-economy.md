# Surplus catalog value references

Keep inventory allocation authoritative and independent of price. Add a mode-bound renderer estimate for confirmed SELL portions only, joining exact snapshot/stack references. Normalize optional item-bundle mode/fetch time and flea rules from the incumbent mode-specific items document; old caches remain readable but do not enable valuation until refreshed.

Primary source inspection on 2026-10-29: https://json.tarkov.dev/endpoints lists mode-specific items; https://json.tarkov.dev/pve/items contains sellToTrader.priceRUB, lastLowPrice, updated, item minLevelForFlea/types and fleaMarket enabled/minPlayerLevel/foundInRaidRequired. The JSON was inspected read-only, without saving fixtures or screenshots. Do not hardcode observed current values. Preserve unknown/missing rules.

Show trader catalog buyback reference and flea gross reference separately, with missing/restricted quantities, explicit quote age and offline status. Flea references require known enabled rules, player/item level, noFlea absence and confirmed FIR when the API requires it. Do not estimate listing fees by simply adding API rates; actual net revenue, condition, access and execution are unverified. Invalid/future timestamps are unknown, stale cached values remain clearly historical. No price may change KEEP/SELL/REVIEW or initiate a sale.

Verify through source review, TypeScript/lint/builds and native embedded build. No tests or game data mutations. This is a valuation reference, not proof that the player can sell those units or receive that amount.

Implemented optional mode/fetch/rule metadata in the existing cached item bundle and a separate surplus reference disclosure in PlanResults. Explicit zero item flea level is retained; missing/invalid item levels remain unknown and block flea valuation. Missing legacy bundle mode prevents price display until a mode-specific refresh, without invalidating inventory. Values join confirmed SELL quantities to exact current snapshot/stack facts and reject inconsistent identities/amounts. Native planner results are unchanged.

The UI lists independently priced trader/flea totals and unpriced/restricted units, network-reported online/offline state, evaluation time, oldest known source/fetch age and stale/unknown-age units. Age is a snapshot at evaluation, updated when plan/catalog/level or network state changes; no idle refresh timer was introduced. Quotes older than an hour are explicitly historical, rather than treated as guaranteed proceeds. Current fee coefficients do not establish a simple fee percentage, so net/actual fees are deliberately not invented. Condition, trader access, offer capacity and additional restrictions remain unverified.

Read-only review found the prior missing-level-to-zero fallback; it was corrected and follow-up review found no remaining P1/P2 issue in scope. Source UI detector returned no findings. No tests, fixtures, player/game state or sales were used. This does not establish actual revenue, full trade eligibility or complete economic modeling.

Verification completed: TypeScript, clean lint, both frontend builds, embedded native build and whitespace checks passed. Rust planner code and allocation behavior were unchanged.

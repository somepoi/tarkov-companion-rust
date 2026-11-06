# Trader-offer access gating

Closes part of "full trade eligibility" for Phase 6. The audit's P1 finding
(*"display sell hints without complete requirements or per-instance
eligibility"*) was still live on several read-only surfaces: they quoted a
catalog `buyFromTrader` price as if the character could pay it.

A `buyFromTrader` entry is a **catalog quote**, not a purchase the player can
make. Actually buying it also depends on three facts that the public catalog
cannot prove:

- the character's **loyalty level** for that trader (`minTraderLevel`)
- whether the offer's **unlock quest** is completed (`taskUnlock`)
- the **units per restock** still available (`buyLimit`, where `0`/absent means
  unknown)

## Defect

| Surface | Claimed |
| --- | --- |
| `FleaMarketPage` "Flip" column and filter | a profit computed as `flea net − buyFromTrader[0].priceRUB` |
| `AmmoPage` price / source | the trader quote as "the cheapest price for one round" |
| `searchbar` item details | "Buy from <trader> for <price>" |
| `searchbar` caliber table | trader quote as the round price |

Each used `buyFromTrader[0]` unconditionally. A player below the required
loyalty, without the unlock quest, or looking at an already-drained restock saw
a confident purchase price and, on the flea page, an invented profit.

### Second defect: only the cheapest quote was judged

The first version of this fix still only inspected `buyFromTrader[0]`. The
adapter sorts offers by price, so index 0 is the **cheapest** quote — which in
the catalog is frequently the one needing the *higher* loyalty level. Judging
only that entry hides a slightly dearer offer the character can genuinely buy,
which is as wrong as promising an unreachable price.

Live catalog (`json.tarkov.dev/pve/items`): 56 items carry more than one
`buyFromTrader` offer; 18 of those have offers at differing loyalty levels.
Example `56d59d3ad2720bdb418b4577`: Mechanic at ₽78 needing LL2, Prapor at ₽89
needing LL1. A LL1 character can buy it from Prapor; the first version reported
"not purchasable".

`bestTraderOffer` now judges every offer and returns the cheapest one that is
actually reachable, so neither an unreachable cheap quote nor a reachable
dearer one is misreported.

### Third defect: surfaces disagreed about the character's loyalty

The first version also collected facts inconsistently. `FleaMarketPage` and
`AmmoPage` read only the hand-set `traderLevels` map, while the search bar used
`progress.traderLevel` (computed from player level and quest reputation, raised
by any hand-set value) and `progress.completed` (ticked *or* inferred). The same
item could therefore be "not purchasable" on the flea page and purchasable in
the search bar.

`src/hooks/useTraderAccessFacts.ts` is now the one facts source for all
surfaces, using the computed loyalty and deduced completed set — the same
numbers the Traders panel and quest screens show. Before the catalogs load it
falls back to the hand-set levels and ticked quests, which are real facts rather
than invented ones.

## Implementation

- New `src/lib/traderAccess.ts` holds one shared rule, `traderOfferAccess`,
  returning either a usable offer or an explicit `unknown` reason. It is the
  single place loyalty, unlock and limit are judged, so the surfaces cannot
  disagree.- `bestTraderOffer` applies that rule to **every** offer and returns the
  cheapest reachable one. All call sites use it rather than `buyFromTrader[0]`.
- Loyalty `0` is treated as the catalog's "no requirement"; `>8`, negative or
  non-integral values are malformed, never "better". A required level with no
  recorded level for this character is unknown, not satisfied.
- A missing unlock completion is unknown. An absent `buyLimit` still allows the
  ordinary **single-unit** price but is reported as no published limit; a
  malformed limit is unknown. The limit caps quantity; it never silently
  disappears.
- `acquireCost` accepts the same facts, so the shared craft/economics path uses
  a trader price only when it is provable.
- Where a quote is not usable the UI keeps the number visible but labels it
  explicitly as a reference that cannot be paid, instead of deleting the
  information or implying eligibility.
- The flea page's trader **sell** list gains the matching note: a catalog
  `sellToTrader` price is what the trader pays for a generic item, not a
  guarantee for a specific stack whose condition and the player's standing are
  unknown. No SELL verdict is produced from it.
- Facts come only from data the app already holds for the current character:
  `store/inventory` per-mode `traderLevels` and the profile's completed quests.
  `useTraderAccessFacts` is the single source so every surface judges with the
  same numbers. It uses the **computed** loyalty (player level + reputation from
  finished quests, raised by a hand-set level) and the **deduced** completed
  quest set — exactly what the Traders panel and quest screens display. Using
  the hand-set map alone would tell a player who never touched the Traders panel
  that nothing is buyable while the panel beside it shows LL2, and would ignore
  unlock quests the app can infer. While catalogs load the hook falls back to
  the hand-set levels and explicitly ticked quests, which are still real facts.
  No new persisted field, schema, IPC shape, adapter version, inference from
  player level alone, or automation was added.

### Fourth defect: the flea average was quoted with no level gate

The same class of defect existed on the *flea* side, and the fix above left it
in place. `acquireCost` used `item.avg24hPrice` whenever the item was not
`noFlea`, and `AmmoPage`'s "Flea market" label plus the search bar's caliber
table and search-result prices did the same. But `avg24hPrice` is the average of
*completed sales*, not a price the character can pay: the flea market refuses
purchases below `fleaMarket.minPlayerLevel` (15) and below the item's own
`minLevelForFlea`, which the catalog publishes as 20/25/30/35/40 for over half
of all items.

`catalogFleaSale` in the same file already gated on exactly those facts — so the
app held the correct rule and simply did not apply it when quoting a purchase.

Measured against live `json.tarkov.dev/pve/items` with the adapted shapes:

| Player level | Correctly priced | Previously quoted anyway |
| --- | --- | --- |
| 1 | 0 | **3743** |
| 15 | 1552 | **2191** |
| 20 | 2434 | 1309 |
| 25 | 3511 | 232 |
| 30 | 3676 | 67 |
| 40 | 3743 | 0 |

No item in the live catalog is missing `minLevelForFlea` with a published
average, so this is a level problem, not a data-gap problem.

`fleaPurchaseAccess` is now the one rule. It requires the catalog's rule block,
the market being enabled, `noFlea` absence, a usable market minimum, a usable
item level and a usable player level; anything unproven returns an explicit
reason. `acquireCost` and `catalogFleaSale` both call it, so buy and sell
valuation can no longer disagree, and `MarketFeeContext` extends the narrower
`FleaRulesContext`.

`useFleaRules` supplies rules plus level for purchase judgements. It is
deliberately **not** `useFleaFees`: a fee estimate additionally needs a recorded
Intelligence Center / Hideout Management level and returns null when that is
unrecorded. Purchase eligibility does not depend on fee modifiers, and reusing
the fee hook would have hidden buyable items for an unrelated reason.

Applied to `AmmoPage` (price, source and a new per-row `fleaNote`), the search
bar's caliber table, search-result item prices and the keys table. Where a level
blocks the price the number is kept but labelled, never silently deleted.
`foundInRaidRequired` stays out of the purchase rule — it restricts selling a
specific stack, not buying a listing — and remains enforced for sell valuation.

## Boundaries

- This does **not** prove current restock state. A confirmed loyalty level plus
  a published `buyLimit` still does not mean units remain right now, and the UI
  says so.
- Free-floating restock timing, edition access and barter exchange availability
  remain uncovered. Quest `traderRequirements` is already enforced where it
  actually applies (see below). Phase 6's "full trade eligibility" stays open;
  this removes two classes of invented purchase price.
- No price, estimate or access verdict changes a KEEP/SELL/REVIEW decision or
  initiates any trade.

### Quest `traderRequirements` gates accepting a quest, not buying an offer

A suggested next gate was to treat a task's `traderRequirements` as gating the
traders' offers. Measurement shows that is a category error. In live
`json.tarkov.dev/pve/tasks`:

| Observation | Count |
| --- | --- |
| tasks with `traderRequirements` | 105 of 499 |
| requirement entries | 119 |
| of those, `requirementType: "level"` | 111 |
| of those, `requirementType: "reputation"` | 8 (all Fence) |

They describe the loyalty needed to **accept the quest**, and that purpose is
already implemented in `src/lib/progression.ts` `lockReasons`: level-type gates
are enforced, and reputation-type gates are deliberately shown as "check in
game" because the app only knows a *lower bound* on reputation (scav karma and
daily quests are absent from the data). `computeTaskStatus` therefore already
locks a quest on them. Nothing about an offer depends on this field.

### Barter exchange arithmetic is already implemented

The other suggested gap — barter availability — already exists in both paths and
needs no new work:

- `src/inventory/recipeCatalog.ts` parses `taskUnlock`, `minTraderLevel`,
  `gameEditions` and the dogtag `minLevel`, emitting explicit gaps when a
  catalog fact is missing.
- `crates/stash-core/src/requirements.rs` (`barter_availability`,
  `trader_loyalty`) refuses to treat a barter as available unless the player
  confirmed the batch count in game, and separately checks trader loyalty and
  the unlock quest.

Verified that `gameEditions` is genuinely absent from the whole barter document
(0 of 892 barters carry the key), so barter edition access is not inventable
from this data and correctly stays a visible coverage gap rather than a guess.

### `buyProhibited` is not a purchase ban (rejected lead)

The obvious-looking next gate — refuse a purchase when the item is in the
trader's `buyProhibited` list — was rejected on measurement, not opinion.

The live trader document does expose `buyAllowed` and `buyProhibited` as
`{ category: string[], items: string[] }` on all 16 traders. Measured against
live `json.tarkov.dev/pve/items`:

| Observation | Count |
| --- | --- |
| `buyProhibited` entries across all traders | 1291 |
| of those, also in that trader's `sellToTrader` (trader buys it from you) | **0** |
| of those, also in that trader's `buyFromTrader` (trader sells it to you) | 2 |

A "you cannot purchase this" list that has *zero* overlap with what the trader
buys from you, and *two* live overlaps with offers the trader demonstrably
sells, is a **sell-direction** fact: items the trader refuses to buy off the
player. Gating purchases on it would block legitimate purchases. Examples that
would have been wrongly blocked: Prapor `68f213f8ea61d1803707cf7a` (`buyLimit`
2) and Ragman `6937efd50543dcc2560a2c81` (`buyLimit` 1).

`buyAllowed` was likewise not treated as a strict allowlist: live items with a
`buyFromTrader` offer sometimes fall outside its listed categories and items, so
it cannot be used as a purchase prerequisite either. Neither list is emitted by
`crates/stash-core/src/catalog/traders.rs`, and neither is needed for this gate.

## Verification

Every check below exited 0 after the final edits:

```
npx tsc -b                                                        0
npm run lint                                                      0
npm run build:tauri-ui                      built in 1.83s
cargo check --workspace                                           0
cargo clippy --workspace --all-targets -- -D warnings              0
cargo clippy --locked --workspace --all-targets -- -D warnings     0
cargo fmt --all -- --check                                        0
cargo build --locked -p tarkov-companion-rust --features custom-protocol   0
```

No tests were created or run, per instruction. No application launch,
screenshot, or actual trade was performed, so runtime rendering and real
in-game eligibility are not claimed. Live catalog reads were read-only
measurements of public data, not game access.

### Flea-level measurement

Replayed read-only against live `json.tarkov.dev/pve/items` using the adapted
shapes the app and Rust catalog emit (`fleaLevel` from `minLevelForFlea`,
`fleaMarket.minPlayerLevel`, `enabled`). Of 3743 items with a published average,
the counts that were *previously* quoted for a character who cannot buy them were
3743 at level 1, 2191 at level 15, 1309 at level 20, 232 at level 25, 67 at level
30 and 0 at level 40. No item with a published average is missing its
`minLevelForFlea`, so no price was blocked by a data gap in this measurement.

### Multi-offer measurement

The rule was replayed read-only against live `json.tarkov.dev/pve/items` for
224 multi-offer cases at four uniform loyalty levels (LL1–LL4 across the major
traders), comparing `buyFromTrader[0]` against `bestTraderOffer`. Result: **11
outcome differences**, all cases where the cheapest quote was blocked but a
dearer reachable offer existed.

One earlier replay of the same idea reported 0 differences. That harness was
wrong: it passed the raw catalog `trader` field, while the app-side
`TraderPrice` uses `traderId`, so `facts.levels[offer.traderId]` looked up
`undefined` and every offer was judged "no loyalty recorded". Re-adapting the
raw offers exactly as `src/api/queries.ts` does produced the 11 differences
above. The module logic was never at fault in that discrepancy.

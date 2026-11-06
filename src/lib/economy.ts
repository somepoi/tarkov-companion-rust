import type { Craft, HideoutStation, Item, ItemsById, ItemsBundle } from '../api/types'
import { prefs } from '../store/prefs'
import { estimateListing, type FeeModifiers } from './fleaFees'
import { bestTraderOffer, type TraderAccessFacts } from './traderAccess'

/** Shown wherever a flea fee is used. */
export const FEE_NOTE =
  'Historical references, not guaranteed trades. Fees use mode-specific catalog rates and Settings → Prices: automatic uses the recorded Intelligence Center level (unrecorded means no discount); forced Yes/No selects a scenario. Discounted estimates require a recorded Hideout Management level. One listing with individually purchasable units; item condition, trader access, slots and actual charges remain unverified.'

export interface MarketFeeContext extends FleaRulesContext {
  modifiers: FeeModifiers
}

/** Generic catalog references cannot establish a physical item's FIR or condition. */
export function catalogFleaSale(item: Item, count: number, context: MarketFeeContext | null) {
  // Selling additionally needs foundInRaidRequired to be explicitly false: a
  // firm requirement cannot be proven from a catalog average. Level, enabled
  // state and `noFlea` come from the same purchase rule so the two cannot drift.
  if (!context || context.catalog.fleaMarket?.foundInRaidRequired !== false) return null
  if (!fleaPurchaseAccess(item, context).available) return null
  if (item.avg24hPrice == null) return null
  const market = context.catalog.fleaMarket
  return estimateListing(item.basePrice, item.avg24hPrice, count, market, context.modifiers)
}

export type FleaPurchaseAccess = { available: true } | { available: false; reason: string }

/** Catalog rules plus the character's level: enough to judge a flea purchase. */
export interface FleaRulesContext {
  catalog: ItemsBundle
  playerLevel: number
}

/**
 * Whether this character can buy from the flea market at all.
 *
 * `avg24hPrice` is the average of completed sales, not a price the character
 * can necessarily pay: the flea market rejects purchases below the market's
 * minimum player level and below the item's own `minLevelForFlea`, and items
 * flagged `noFlea` are never listed. Treating the average as payable told a
 * level-15 character a price for 2191 catalog items whose item-level gate is
 * 20–40.
 *
 * Missing or malformed rules and levels stay unknown (`available: false` with a
 * reason) rather than being assumed permissive. `foundInRaidRequired` is not
 * consulted: it restricts *selling* a specific stack, not buying a listing.
 */
export function fleaPurchaseAccess(item: Item, context: FleaRulesContext | null): FleaPurchaseAccess {
  if (!context) return { available: false, reason: 'flea market rules are not loaded' }
  const market = context.catalog.fleaMarket
  if (!context.catalog.mode || context.catalog.items[item.id] !== item)
    return { available: false, reason: 'the item does not belong to the loaded catalog' }
  if (market?.enabled !== true) return { available: false, reason: 'the flea market is disabled' }
  if (item.types.includes('noFlea')) return { available: false, reason: 'this item cannot be traded on the flea market' }
  const minimum = market.minPlayerLevel
  if (minimum == null || !Number.isSafeInteger(minimum) || minimum < 0)
    return { available: false, reason: "the flea market's minimum level is unknown" }
  const level = item.fleaLevel
  if (level == null || !Number.isSafeInteger(level) || level < 0)
    return { available: false, reason: "the item's flea level is unknown" }
  if (!Number.isSafeInteger(context.playerLevel) || context.playerLevel < 0)
    return { available: false, reason: 'your player level is unknown' }
  const need = Math.max(minimum, level)
  if (context.playerLevel < need) return { available: false, reason: `the flea market needs player level ${need}` }
  return { available: true }
}

/**
 * Cost of one unit: flea average or trader price. Settings → Prices decides which counts:
 * best = the cheaper known one, trader / flea = that one first (the other only when it is unknown).
 *
 * A trader quote is only usable when `facts` prove this character can buy the
 * offer, and a flea average only when `fleaContext` proves the market accepts a
 * purchase of that item at this character's level. Without that evidence the
 * respective side stays unknown rather than quoting an unreachable price.
 */
export function acquireCost(item: Item | undefined, facts?: TraderAccessFacts, fleaContext: FleaRulesContext | null = null): number | null {
  if (!item) return null
  const flea = fleaPurchaseAccess(item, fleaContext).available ? item.avg24hPrice : null
  // Judge every offer: the cheapest quote may need a loyalty level this
  // character has not recorded, while a slightly dearer one is reachable.
  const access = facts ? bestTraderOffer(item.buyFromTrader, facts) : null
  const trader = access?.kind === 'available' ? access.priceRUB : null
  if (flea == null && trader == null) return null
  if (flea == null) return trader
  if (trader == null) return flea
  const source = prefs().priceSource
  return source === 'trader' ? trader : source === 'flea' ? flea : Math.min(flea, trader)
}

/** Best price you can get for one unit: flea (minus fee) or trader buy-back. */
export function sellValue(item: Item | undefined, count = 1, context: MarketFeeContext | null = null): { total: number | null; via: 'flea' | 'trader' | null } {
  if (!item || !Number.isSafeInteger(count) || count <= 0) return { total: null, via: null }
  const quotedTrader = item.sellToTrader[0]?.priceRUB
  const value = quotedTrader != null && Number.isSafeInteger(quotedTrader) && quotedTrader > 0 ? quotedTrader * count : NaN
  const trader = Number.isSafeInteger(value) && value > 0 ? value : null
  const net = catalogFleaSale(item, count, context)?.net ?? null
  const source = prefs().priceSource
  if (source === 'trader' && trader !== null) return { total: trader, via: 'trader' }
  if (source === 'flea' && net !== null) return { total: net, via: 'flea' }
  if (net !== null && (trader === null || net >= trader)) return { total: net, via: 'flea' }
  return { total: trader, via: trader === null ? null : 'trader' }
}

export interface CraftEconomics {
  craft: Craft
  station: HideoutStation | undefined
  outputItem: Item | undefined
  inputCost: number | null
  revenue: number | null
  revenueVia: 'flea' | 'trader' | null
  profit: number | null
  profitPerHour: number | null
  /** True when some input has no known price (cost is a lower bound). */
  partialCost: boolean
}

export function craftEconomics(craft: Craft, items: ItemsById, stationsById: Record<string, HideoutStation>, context: MarketFeeContext | null = null, facts?: TraderAccessFacts): CraftEconomics {
  const outputItem = items[craft.output.itemId]
  let inputCost = 0
  let partial = false
  for (const inp of craft.inputs) {
    if (inp.tool) continue // tools are returned after the craft
    const c = acquireCost(items[inp.itemId], facts, context)
    const cost = c == null ? NaN : c * inp.count
    if (c == null || !Number.isSafeInteger(c) || c < 0 || !Number.isSafeInteger(inp.count) || inp.count <= 0
      || !Number.isSafeInteger(cost) || !Number.isSafeInteger(inputCost + cost)) partial = true
    else inputCost += cost
  }
  const sale = sellValue(outputItem, craft.output.count, context)
  const difference = sale.total === null || partial ? null : sale.total - inputCost
  const profit = difference !== null && Number.isSafeInteger(difference) ? difference : null
  const hours = craft.duration / 3600
  const hourly = profit !== null && Number.isFinite(hours) && hours > 0 ? Math.round(profit / hours) : null
  return {
    craft,
    station: stationsById[craft.stationId],
    outputItem,
    inputCost,
    revenue: sale.total,
    revenueVia: sale.via,
    profit: outputItem ? profit : null,
    profitPerHour: outputItem && hourly !== null && Number.isSafeInteger(hourly) ? hourly : null,
    partialCost: partial,
  }
}

export function formatDuration(seconds: number): string {
  if (!seconds) return 'instant'
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  if (h >= 24) {
    const d = Math.floor(h / 24)
    return `${d}d ${h % 24}h`
  }
  if (h > 0) return m ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

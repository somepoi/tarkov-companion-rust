import type { Craft, HideoutStation, Item, ItemsById, ItemsBundle } from '../api/types'
import { prefs } from '../store/prefs'
import { estimateListing, type FeeModifiers } from './fleaFees'

/** Shown wherever a flea fee is used. */
export const FEE_NOTE =
  'Historical references, not guaranteed trades. Fees use mode-specific catalog rates and Settings → Prices: automatic uses the recorded Intelligence Center level (unrecorded means no discount); forced Yes/No selects a scenario. Discounted estimates require a recorded Hideout Management level. One listing with individually purchasable units; item condition, trader access, slots and actual charges remain unverified.'

export interface MarketFeeContext {
  catalog: ItemsBundle
  playerLevel: number
  modifiers: FeeModifiers
}

/** Generic catalog references cannot establish a physical item's FIR or condition. */
export function catalogFleaSale(item: Item, count: number, context: MarketFeeContext | null) {
  const market = context?.catalog.fleaMarket
  if (!context || !context.catalog.mode || context.catalog.items[item.id] !== item
    || market?.enabled !== true || market.foundInRaidRequired !== false || item.types.includes('noFlea')
    || !Number.isSafeInteger(context.playerLevel) || !Number.isSafeInteger(market.minPlayerLevel)
    || market.minPlayerLevel === null || market.minPlayerLevel < 0
    || item.fleaLevel == null || !Number.isSafeInteger(item.fleaLevel) || item.fleaLevel < 0
    || context.playerLevel < Math.max(market.minPlayerLevel, item.fleaLevel)
    || item.avg24hPrice == null) return null
  return estimateListing(item.basePrice, item.avg24hPrice, count, market, context.modifiers)
}

/**
 * Cost of one unit: flea average or trader price. Settings → Prices decides which counts:
 * best = the cheaper known one, trader / flea = that one first (the other only when it is unknown).
 */
export function acquireCost(item: Item | undefined): number | null {
  if (!item) return null
  const flea = item.types.includes('noFlea') ? null : item.avg24hPrice
  const trader = item.buyFromTrader[0]?.priceRUB ?? null
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

export function craftEconomics(craft: Craft, items: ItemsById, stationsById: Record<string, HideoutStation>, context: MarketFeeContext | null = null): CraftEconomics {
  const outputItem = items[craft.output.itemId]
  let inputCost = 0
  let partial = false
  for (const inp of craft.inputs) {
    if (inp.tool) continue // tools are returned after the craft
    const c = acquireCost(items[inp.itemId])
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

/** Reference prices and tracked requirement hints. Detections do not establish safe surplus. */
import type { Item, ItemsById } from '../api/types'
import { remainingFor, type ItemNeed, type NeedSource } from '../lib/needs'
import type { Detection } from './core'
import { needKind, type KeepKind } from './keepKinds'

export type Confidence = 'sure' | 'likely' | 'check'

/** Sure only when the match is close AND clearly better than the next item (BEAR vs USEC tags etc.). */
export const confidence = (error: number, margin = Infinity, nameMatch = false): Confidence =>
  nameMatch ? (error < 20 ? 'sure' : 'likely') : error < 12 && margin >= 1.5 ? 'sure' : error < 18 ? 'likely' : 'check'

export const marginOf = (d: Detection) => (d.alternatives.length ? d.alternatives[0].error - d.error : Infinity)

/** "Gunsmith - Part 1 (Mechanic)", "Lavatory level 2". */
export function sourceLabel(s: NeedSource): string {
  if (s.kind === 'quest') return `${s.name} (${s.traderName})`
  if (s.kind === 'hideout') return /level/i.test(s.name) ? s.name : `${s.name} level ${s.level}`
  return `craft: ${s.name}`
}

/** What an item counts toward: the need (its canonical item), how many are still missing, and for what. */
export interface NeedInfo {
  needId: string
  remaining: number
  total: number
  sources: NeedSource[]
}

/**
 * Item id (including the alternatives a quest also accepts) → the need it counts toward. With
 * `kinds`, only those needs count (no quests: only what the hideout still wants).
 */
export function needLookup(needs: Iterable<ItemNeed>, collected: Record<string, number>, kinds?: ReadonlySet<KeepKind>): Map<string, NeedInfo> {
  const m = new Map<string, NeedInfo>()
  for (const n of needs) {
    const sources = kinds ? n.sources.filter((s) => kinds.has(needKind(s))) : n.sources
    if (sources.length === 0) continue
    const all = sources.length === n.sources.length
    const total = all ? n.total : sources.reduce((sum, s) => sum + (s.count ?? 0), 0)
    const remaining = sources.some((s) => s.count === null) ? Infinity
      : all ? remainingFor(n, collected[n.itemId] ?? 0) : Math.max(0, total - (collected[n.itemId] ?? 0))
    const entry = { needId: n.itemId, remaining, total, sources }
    m.set(n.itemId, entry)
    for (const alt of n.alternatives) if (!m.has(alt)) m.set(alt, entry)
  }
  return m
}

/** One item found in the snip: how many, where (indexes into the detections), and how sure. */
export interface FoundItem {
  itemId: string
  count: number
  spots: number[]
  confidence: Confidence
}

const confidenceOrder = { sure: 0, likely: 1, check: 2 }

/** Every match in a row shares its least certain confidence. */
export function groupDetections(detections: Detection[]): FoundItem[] {
  const grouped = new Map<string, FoundItem>()
  detections.forEach((d, i) => {
    if (!d.itemId) return
    const match = confidence(d.error, marginOf(d), Boolean(d.nameMatch))
    const row = grouped.get(d.itemId)
    if (row) {
      row.spots.push(i)
      row.count++
      if (confidenceOrder[match] > confidenceOrder[row.confidence]) row.confidence = match
    } else {
      grouped.set(d.itemId, { itemId: d.itemId, spots: [i], count: 1, confidence: match })
    }
  })
  return [...grouped.values()]
}

export interface SellLine {
  itemId: string
  count: number
  /** One unit, at the best of flea (after the fee) and traders. */
  each: number
  /** All `count` units together (the flea fee is per offer, so not always each × count). */
  total: number
  perSlot: number
  via: 'flea' | 'trader' | null
  confidence: Confidence
}

export interface KeepLine {
  itemId: string
  count: number
  /** What it is still needed for (absent when it is only kept for its kind). */
  need?: NeedInfo
  /** Kept whole because its kind is ticked (keys, ammo…). */
  kind?: KeepKind
  /** A quest or hideout level wants it found in raid (the snip cannot see the tick). */
  fir: boolean
  confidence: Confidence
}

export interface StashValues {
  sell: SellLine[]
  keep: KeepLine[]
  /** All the spare items together. */
  total: number
}

export type SellSort = 'total' | 'each' | 'slot'

export function sortSell(lines: SellLine[], by: SellSort, nameOf: (id: string) => string = (id) => id): SellLine[] {
  const key = (l: SellLine) => (by === 'each' ? l.each : by === 'slot' ? l.perSlot : l.total)
  return [...lines].sort((a, b) => key(b) - key(a) || nameOf(a.itemId).localeCompare(nameOf(b.itemId)))
}

/**
 * Splits what was found: up to what you still need goes to "keep" (shared by items that count
 * toward the same need), the rest to "sell", priced with `price` (sellValue from lib/economy).
 */
export function stashValues(
  found: FoundItem[],
  needFor: Map<string, NeedInfo>,
  items: ItemsById,
  price: (item: Item | undefined, count: number) => { total: number | null; via: 'flea' | 'trader' | null },
  keepWhole: (item: Item | undefined) => KeepKind | null = () => null,
): StashValues {
  const left = new Map<string, number>()
  const sell: SellLine[] = []
  const keep: KeepLine[] = []
  // Surer finds claim the needed count first, so a doubtful one is the one marked spare.
  for (const f of [...found].sort((a, b) => confidenceOrder[a.confidence] - confidenceOrder[b.confidence])) {
    const need = needFor.get(f.itemId)
    const remaining = need ? (left.get(need.needId) ?? need.remaining) : 0
    const kept = Math.min(f.count, remaining)
    const item = items[f.itemId]
    const whole = keepWhole(item)
    const needed = need && kept > 0 ? need : undefined
    if (needed) left.set(needed.needId, remaining - kept)
    if (needed || whole)
      keep.push({
        itemId: f.itemId,
        count: whole ? f.count : kept,
        ...(needed ? { need: needed } : {}),
        ...(whole ? { kind: whole } : {}),
        fir: Boolean(needed?.sources.some((s) => 'fir' in s && s.fir)),
        confidence: f.confidence,
      })
    const spare = whole ? 0 : f.count - kept
    if (spare <= 0) continue
    const each = price(item, 1)
    const all = price(item, spare)
    const slots = item ? Math.max(1, item.width * item.height) : 1
    sell.push({ itemId: f.itemId, count: spare, each: each.total ?? 0, total: all.total ?? 0, perSlot: Math.round((each.total ?? 0) / slots), via: all.via ?? each.via, confidence: f.confidence })
  }
  return { sell: sortSell(sell, 'total', (id) => items[id]?.name ?? id), keep, total: sell.reduce((s, l) => s + l.total, 0) }
}

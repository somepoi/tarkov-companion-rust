import type { Craft, HideoutStation, ItemsById, Task } from '../api/types'
import type { Faction } from '../store/progress'
import { isFactionEligible } from './taskStatus'

export type NeedSource =
  | { kind: 'quest'; id: string; name: string; traderId: string; traderName: string; count: number | null; fir: boolean | null }
  | { kind: 'hideout'; id: string; name: string; stationId: string; level: number; count: number | null; fir: boolean | null }
  | { kind: 'craft'; id: string; name: string; stationId: string; count: number }

export interface ItemNeed {
  itemId: string
  fir: number
  nonFir: number
  /** Quantities whose FIR requirement was not provided by the source. */
  unknownFir: number
  /** A requirement exists, but its quantity cannot be safely added to the total. */
  quantityUnknown: boolean
  total: number
  sources: NeedSource[]
  /** Other item ids the quest would also accept (first id is the canonical one). */
  alternatives: string[]
}

export interface NeedsInput {
  tasks: Task[]
  completedTaskIds: ReadonlySet<string>
  faction: Faction
  stations: HideoutStation[]
  stationLevels: Record<string, number>
  crafts: Craft[]
  favoriteCraftIds: string[]
  items?: ItemsById
}

/** Objective types where the item leaves your stash. */
const HAND_IN_TYPES = new Set(['giveItem', 'plantItem'])

/** Roubles, dollars, euros: money is not something you "collect". */
export const CURRENCY_ITEM_IDS = new Set(['5449016a4bdc2d6f028b456f', '5696686a4bdc2da3298b456a', '569668774bdc2da2298b4568'])

/**
 * Every item still needed by incomplete quests, unbuilt hideout levels and
 * favourite crafts in the current game mode. Pure and cheap; memoise per input.
 */
export function computeNeeds(input: NeedsInput): Map<string, ItemNeed> {
  const needs = new Map<string, ItemNeed>()
  const get = (itemId: string): ItemNeed => {
    let n = needs.get(itemId)
    if (!n) {
      n = { itemId, fir: 0, nonFir: 0, unknownFir: 0, quantityUnknown: false, total: 0, sources: [], alternatives: [] }
      needs.set(itemId, n)
    }
    return n
  }
  const add = (itemId: string, count: number | null, fir: boolean | null, source: NeedSource, alternatives: string[] = []) => {
    if (!itemId || count === 0 || CURRENCY_ITEM_IDS.has(itemId)) return
    const n = get(itemId)
    // A missing/invalid amount is evidence of a requirement, not one assumed item.
    if (count === null || !Number.isSafeInteger(count) || count < 0) n.quantityUnknown = true
    else {
      if (fir === true) n.fir += count
      else if (fir === false) n.nonFir += count
      else n.unknownFir += count
      n.total += count
    }
    n.sources.push(source)
    for (const a of alternatives) if (a !== itemId && !n.alternatives.includes(a)) n.alternatives.push(a)
  }

  for (const task of input.tasks) {
    if (input.completedTaskIds.has(task.id) || !isFactionEligible(task, input.faction)) continue
    for (const o of task.objectives) {
      if (!HAND_IN_TYPES.has(o.type) || o.itemIds.length === 0 || o.optional) continue
      add(
        o.itemIds[0],
        o.count,
        o.foundInRaid,
        { kind: 'quest', id: task.id, name: task.name, traderId: task.trader.id, traderName: task.trader.name, count: o.count, fir: o.foundInRaid },
        o.itemIds.slice(1),
      )
    }
  }

  for (const station of input.stations) {
    const current = input.stationLevels[station.id] ?? 0
    for (const level of station.levels) {
      if (level.level <= current) continue
      for (const req of level.itemRequirements) {
        add(req.itemId, req.count, req.foundInRaid, {
          kind: 'hideout',
          id: level.id,
          name: `${station.name} level ${level.level}`,
          stationId: station.id,
          level: level.level,
          count: req.count,
          fir: req.foundInRaid,
        })
      }
    }
  }

  const fav = new Set(input.favoriteCraftIds)
  for (const craft of input.crafts) {
    if (!fav.has(craft.id)) continue
    const outputName = input.items?.[craft.output.itemId]?.name ?? 'craft'
    for (const inp of craft.inputs) {
      if (inp.tool) continue
      add(inp.itemId, inp.count, false, { kind: 'craft', id: craft.id, name: `Craft: ${outputName}`, stationId: craft.stationId, count: inp.count })
    }
  }
  return needs
}

/** Remaining count after what has been collected. */
export function remainingFor(need: ItemNeed, collected: number): number {
  return Math.max(0, need.total - collected)
}

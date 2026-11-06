/**
 * Where every hideout station stands for the Hideout tab's bunker view: its level, the next level,
 * and whether that can be built now (only facts from the data and what you set in the app: station
 * levels, Item Collection counts, trader loyalty; skills are listed but cannot be known).
 */
import type { HideoutLevel, HideoutStation } from '../api/types'
import { CURRENCY_ITEM_IDS } from './needs'

/** Build readiness reflects tracked requirements, with a review state for unverified item facts. */
export type StationState = 'max' | 'ready' | 'items' | 'review' | 'locked'

export interface StationInfo {
  station: HideoutStation
  level: number
  max: number
  next: HideoutLevel | null
  state: StationState
  /** Station levels the next level needs that are not built yet. */
  blockedBy: { stationId: string; level: number; have: number }[]
  /** Trader loyalty the next level needs that you do not have. */
  traderGaps: { traderId: string; level: number; have: number }[]
  /** Items of the next level still missing (Item Collection counts; money is not collected there). */
  missing: { itemId: string; count: number; have: number }[]
  /** Levels of other stations that need this one, not built yet. */
  unlocks: { stationId: string; level: number; needs: number }[]
}

export function stationInfo(
  stations: HideoutStation[],
  stationLevels: Record<string, number>,
  collected: Record<string, number>,
  /** Loyalty per trader id (null: not known, then trader gates do not lock). */
  traderLevel: Record<string, number> | null,
): Map<string, StationInfo> {
  const out = new Map<string, StationInfo>()
  for (const station of stations) {
    const level = stationLevels[station.id] ?? 0
    const max = station.levels.reduce((m, l) => Math.max(m, l.level), 0)
    const next = station.levels.find((l) => l.level === level + 1) ?? null
    const blockedBy = (next?.stationLevelRequirements ?? []).filter((r) => (stationLevels[r.stationId] ?? 0) < r.level).map((r) => ({ ...r, have: stationLevels[r.stationId] ?? 0 }))
    const traderGaps = traderLevel ? (next?.traderRequirements ?? []).filter((r) => (traderLevel[r.traderId] ?? 1) < r.level).map((r) => ({ ...r, have: traderLevel[r.traderId] ?? 1 })) : []
    const missing: StationInfo['missing'] = []
    let itemsNeedReview = false
    for (const requirement of next?.itemRequirements ?? []) {
      const { itemId, count, foundInRaid } = requirement
      if (CURRENCY_ITEM_IDS.has(itemId)) continue
      const have = collected[itemId] ?? 0
      if (count !== null && have < count) missing.push({ itemId, count, have })
      // Item Collection counts cannot verify where an item came from.
      if (count === null || (count > 0 && foundInRaid !== false)) itemsNeedReview = true
    }
    const unlocks: StationInfo['unlocks'] = []
    for (const other of stations) {
      if (other.id === station.id) continue
      for (const l of other.levels) {
        if (l.level <= (stationLevels[other.id] ?? 0)) continue
        const r = l.stationLevelRequirements.find((x) => x.stationId === station.id)
        if (r) unlocks.push({ stationId: other.id, level: l.level, needs: r.level })
      }
    }
    let state: StationState = 'ready'
    if (!next) state = 'max'
    else if (blockedBy.length || traderGaps.length) state = 'locked'
    else if (missing.length) state = 'items'
    else if (itemsNeedReview) state = 'review'
    out.set(station.id, { station, level, max, next, state, blockedBy, traderGaps, missing, unlocks })
  }
  return out
}

export interface HideoutSummary {
  built: number
  total: number
  ready: number
  items: number
  review: number
  locked: number
  max: number
}

export function hideoutSummary(infos: Iterable<StationInfo>): HideoutSummary {
  const s: HideoutSummary = { built: 0, total: 0, ready: 0, items: 0, review: 0, locked: 0, max: 0 }
  for (const i of infos) {
    s.built += Math.min(i.level, i.max)
    s.total += i.max
    s[i.state] += 1
  }
  return s
}

/** Bonus types whose value is a fraction (0.15 = 15 %). */
const PERCENT_BONUS = /^(ExperienceRate|SkillGroupLevelingBoost|EnergyRegeneration|HealthRegeneration|HydrationRegeneration|DebuffEndDelay|FuelConsumption|InsuranceReturnTime|RagfairCommission|ScavCooldownTimer|QuestMoneyReward|RepairArmorBonus|RepairWeaponBonus)$/

/** "Flea Market fee −30%", "Skill group leveling (Practical) +30%", "Additional slots +2". */
export function bonusText(b: HideoutLevel['bonuses'][number]): string {
  const name = b.skill ? `${b.name} (${b.skill})` : b.name
  // Unlocks say it all; the stash value is an internal grid id, not a size.
  if (b.value == null || b.value === 0 || /^Unlock|^StashSize$|^TextBonus$/.test(b.type)) return name
  const sign = b.value > 0 ? '+' : '−'
  if (PERCENT_BONUS.test(b.type)) return `${name} ${sign}${Math.round(Math.abs(b.value) * 1000) / 10}%`
  return `${name} ${sign}${Math.abs(b.value)}`
}

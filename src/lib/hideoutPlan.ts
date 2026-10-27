import type { HideoutLevel, HideoutStation } from '../api/types'

export interface NextLevel {
  station: HideoutStation
  level: HideoutLevel
  /** Unmet station prerequisites, e.g. "Generator 2". */
  blockedBy: string[]
  prereqsMet: boolean
  /** Items still missing (needed - collected), ignoring money. */
  missingItems: number
}

/** The next level of every station, buildable ones first. */
export function nextHideoutLevels(
  stations: HideoutStation[],
  stationLevels: Record<string, number>,
  collected: Record<string, number>,
  currencyIds: ReadonlySet<string>,
): NextLevel[] {
  const byId = new Map(stations.map((s) => [s.id, s]))
  const out: NextLevel[] = []
  for (const station of stations) {
    const cur = stationLevels[station.id] ?? 0
    const level = station.levels.find((l) => l.level === cur + 1)
    if (!level) continue
    const blockedBy = level.stationLevelRequirements
      .filter((r) => (stationLevels[r.stationId] ?? 0) < r.level)
      .map((r) => `${byId.get(r.stationId)?.name ?? 'Station'} ${r.level}`)
    let missingItems = 0
    for (const r of level.itemRequirements) {
      if (currencyIds.has(r.itemId)) continue
      if (r.count === null) {
        if (!blockedBy.includes('Verify unknown item quantities')) blockedBy.push('Verify unknown item quantities')
        continue
      }
      missingItems += Math.max(0, r.count - (collected[r.itemId] ?? 0))
    }
    out.push({ station, level, blockedBy, prereqsMet: blockedBy.length === 0, missingItems })
  }
  return out.sort((a, b) => Number(!a.prereqsMet) - Number(!b.prereqsMet) || a.missingItems - b.missingItems || a.station.name.localeCompare(b.station.name))
}

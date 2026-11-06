import { useMemo } from 'react'
import type { HideoutStation } from '../api/types'
import { useHideoutSpots } from '../store/hideoutSpots'
import { spotsFor, type Pt, type Spot } from './plan'

export type SpotSource = Spot['source'] | 'moved'

/** Every station's spot: the player's own (moved) first, then the built-in plan. */
export function useStationSpots(stations: HideoutStation[]): Record<string, { at: Pt; source: SpotSource }> {
  const moved = useHideoutSpots((s) => s.spots)
  return useMemo(() => {
    const base = spotsFor(stations.map((s) => s.normalizedName))
    const out: Record<string, { at: Pt; source: SpotSource }> = {}
    for (const s of stations) {
      const own = moved[s.normalizedName]
      out[s.id] = own ? { at: own, source: 'moved' } : base[s.normalizedName]
    }
    return out
  }, [stations, moved])
}

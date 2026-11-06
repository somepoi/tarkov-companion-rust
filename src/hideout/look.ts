/** What a station tile on the Hideout tab shows, and the wording for it. */
import type { StationInfo, StationState } from '../lib/hideoutState'
import type { BuildTimer } from '../store/hideoutTimers'

/** The build state, or a running / finished build timer. */
export type Look = StationState | 'building' | 'done'

/** The timer for the station's next level (an older one, e.g. for a level marked built elsewhere, does not count). */
export function activeTimer(info: StationInfo, timer: BuildTimer | undefined): BuildTimer | undefined {
  return timer && info.next && timer.level === info.next.level ? timer : undefined
}

export function lookOf(info: StationInfo, timer: BuildTimer | undefined, now: number): Look {
  const t = activeTimer(info, timer)
  if (t) return now < t.endsAt ? 'building' : 'done'
  return info.state
}

/** "4h 12m", "3m 05s", "2d 4h". */
export function timeLeft(ms: number): string {
  if (ms <= 0) return 'done'
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h) return `${h}h ${m}m`
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s % 60}s`
}

export interface Names {
  station: (id: string) => string
  trader: (id: string) => string
}

/** `short`: the tile's chip, where a lock icon already says "needs". */
export function lookLabel(look: Look, info: StationInfo, names: Names, short = false): string {
  const needs = short ? '' : 'Needs '
  switch (look) {
    case 'max':
      return 'Fully built'
    case 'ready':
      return 'Tracked requirements met'
    case 'items':
      return `${info.missing.length} item${info.missing.length === 1 ? '' : 's'} to find`
    case 'review':
      return 'Check item requirements'
    case 'building':
      return 'Building'
    case 'done':
      return 'Finished?'
    case 'locked': {
      const s = info.blockedBy[0]
      if (s) return `${needs}${names.station(s.stationId)} ${s.level}`
      const t = info.traderGaps[0]
      return t ? `${needs}${names.trader(t.traderId)} LL${t.level}` : 'Locked'
    }
  }
}

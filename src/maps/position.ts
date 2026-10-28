/**
 * "Where am I": the latest position read from an in-game screenshot's file name (desktop),
 * tagged with the map you were on (the last raid's map from the game log, else the map open
 * in the app). Not persisted: a position is only useful during the raid.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { useGameData } from '../api/hooks'
import { useDesktopStore } from '../desktop/useDesktop'
import type { PlayerPosition } from '../shared/desktop-api'
import { useUiStore } from '../store/ui'
import { useProgressStore } from '../store/progress'

interface PositionState {
  pos: (PlayerPosition & { mapKey: string | null }) | null
  set: (pos: PositionState['pos']) => void
  error: string | null
  setError: (error: string | null) => void
  contextAfter: number
  reset: () => void
}

export const usePositionStore = create<PositionState>()((set) => ({
  pos: null,
  error: null,
  setError: (error) => set({ error }),
  contextAfter: 0,
  reset: () => set({ pos: null, contextAfter: Date.now() }),
  set: (pos) => set({ pos }),
}))

/** Desktop: listens for new in-game screenshots (and picks up a recent one at start). */
export function PositionListener() {
  const maps = useGameData().data?.maps
  useEffect(() => {
    const api = window.desktop
    if (!api?.onPosition) return
    const mapKeyNow = () => {
      const loc = useDesktopStore.getState().lastRaidLocation
      const fromRaid = loc ? maps?.find((m) => m.nameId.toLowerCase() === loc.toLowerCase())?.normalizedName : undefined
      return fromRaid ?? useUiStore.getState().lastMapKey ?? null
    }
    let active = true
    let revision = 0
    const reset = () => {
      revision++
      usePositionStore.getState().reset()
    }
    const enabled = () => useDesktopStore.getState().settings?.trackPosition !== false
    const receive = (p: PlayerPosition) => {
      if (active && enabled() && p.at >= usePositionStore.getState().contextAfter) {
        revision++
        usePositionStore.getState().set({ ...p, mapKey: mapKeyNow() })
        usePositionStore.getState().setError(null)
      }
    }
    const unposition = api.onPosition(receive)
    const unerror = api.onPositionError?.((message) => usePositionStore.getState().setError(message))
    const unevent = api.onEvent((e) => {
      if (!e.historical && ['sessionMode', 'profile', 'gameVersion', 'mapLoading', 'raidMatched', 'raidStarting', 'raidStarted', 'raidEnded', 'matchingAborted'].includes(e.kind)) reset()
    })
    const unmode = useProgressStore.subscribe((next, previous) => { if (next.gameMode !== previous.gameMode) reset() })
    const unsettings = useDesktopStore.subscribe((next, previous) => {
      if (next.settings?.trackPosition !== previous.settings?.trackPosition && !enabled()) reset()
      const a = next.state, b = previous.state
      if (a?.logsPath !== b?.logsPath || a?.currentFolder !== b?.currentFolder || a?.profileId !== b?.profileId || a?.sessionMode !== b?.sessionMode || (a?.status !== b?.status && a?.status !== 'watching')) reset()
    })
    const initial = revision
    void api.getLatestPosition().then((p) => {
      if (p && active && revision === initial && !usePositionStore.getState().pos) receive(p)
    }).catch((error: unknown) => { if (active) usePositionStore.getState().setError(String(error)) })
    return () => { active = false; unposition(); unerror?.(); unevent(); unmode(); unsettings() }
  }, [maps])
  return null
}

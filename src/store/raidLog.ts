/**
 * Legacy raid results kept for progress export and import after the raid log UI was removed.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GameMode } from '../api/client'

type RaidResult = 'survived' | 'died' | 'mia' | 'runthrough'
type RaidRole = 'pmc' | 'scav'

export interface RaidEntry {
  result?: RaidResult
  role?: RaidRole
  note?: string
}

/** A raid added by hand (the game did not log it on this PC). */
export interface ManualRaid {
  key: string
  /** Map display name. */
  location: string
  at: number
  minutes: number | null
}

interface RaidLogState {
  byMode: Record<GameMode, Record<string, RaidEntry>>
  manual: Record<GameMode, ManualRaid[]>
  /** Logged raids the user hid (wrong entries, e.g. a loading screen counted as a raid). */
  hidden: Record<GameMode, string[]>
  importAll: (byMode: Record<GameMode, Record<string, RaidEntry>>, manual?: Record<GameMode, ManualRaid[]>, hidden?: Record<GameMode, string[]>) => void
}

export const useRaidLogStore = create<RaidLogState>()(
  persist(
    (set) => ({
      byMode: { regular: {}, pve: {} },
      manual: { regular: [], pve: [] },
      hidden: { regular: [], pve: [] },
      importAll: (byMode, manual, hidden) => set({ byMode, manual: manual ?? { regular: [], pve: [] }, hidden: hidden ?? { regular: [], pve: [] } }),
    }),
    {
      name: 'tarkov-companion-raid-log',
      version: 1,
      // Saves from 1.8.0 have no manual/hidden lists yet.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<RaidLogState>
        return { ...current, byMode: p.byMode ?? current.byMode, manual: p.manual ?? current.manual, hidden: p.hidden ?? current.hidden }
      },
    },
  ),
)

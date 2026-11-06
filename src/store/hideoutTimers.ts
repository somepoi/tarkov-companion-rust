/**
 * Hideout build timers per game mode, started by hand on the Hideout tab (the game logs say
 * nothing about construction). One timer per station: the level being built and when it ends.
 * The station level itself only changes when the player marks it built.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GameMode } from '../api/client'
import { guarded } from './guarded'

export interface BuildTimer {
  level: number
  startedAt: number
  endsAt: number
  /** "Generator level 2" (for the notification, without loading the hideout data). */
  label: string
  /** Set once the "done" notification was shown. */
  notified?: boolean
}

export type TimersByMode = Record<GameMode, Record<string, BuildTimer>>

interface HideoutTimersState {
  byMode: TimersByMode
  start: (mode: GameMode, stationId: string, timer: Omit<BuildTimer, 'notified'>) => void
  clear: (mode: GameMode, stationId: string) => void
  markNotified: (mode: GameMode, stationId: string) => void
}

const empty = (): TimersByMode => ({ regular: {}, pve: {} })

export function parseTimers(v: unknown): TimersByMode | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out = empty()
  for (const mode of ['regular', 'pve'] as const) {
    const list = (v as Record<string, unknown>)[mode]
    if (typeof list !== 'object' || list === null || Array.isArray(list)) continue
    for (const [id, t] of Object.entries(list as Record<string, unknown>)) {
      if (id === 'prototype' || Object.hasOwn(Object.prototype, id) || typeof t !== 'object' || t === null || Array.isArray(t)) continue
      const { level, startedAt, endsAt, label, notified } = t as Partial<BuildTimer>
      if (typeof level !== 'number' || !Number.isSafeInteger(level) || level < 1) continue
      if (typeof startedAt !== 'number' || !Number.isFinite(startedAt) || startedAt < 0) continue
      if (typeof endsAt !== 'number' || !Number.isFinite(endsAt) || endsAt <= startedAt || typeof label !== 'string') continue
      out[mode][id] = { level, startedAt, endsAt, label, notified: notified === true }
    }
  }
  return out
}

export const useHideoutTimers = create<HideoutTimersState>()(
  persist(
    (set) => ({
      byMode: empty(),
      start: (mode, stationId, timer) => set((s) => ({ byMode: { ...s.byMode, [mode]: { ...s.byMode[mode], [stationId]: { ...timer, notified: false } } } })),
      clear: (mode, stationId) =>
        set((s) => {
          if (!s.byMode[mode][stationId]) return s
          const next = { ...s.byMode[mode] }
          delete next[stationId]
          return { byMode: { ...s.byMode, [mode]: next } }
        }),
      markNotified: (mode, stationId) =>
        set((s) => {
          const t = s.byMode[mode][stationId]
          return t ? { byMode: { ...s.byMode, [mode]: { ...s.byMode[mode], [stationId]: { ...t, notified: true } } } } : s
        }),
    }),
    { name: 'tarkov-companion-hideout-timers', version: 1, ...guarded<HideoutTimersState>({ byMode: (v) => parseTimers(v) }) },
  ),
)

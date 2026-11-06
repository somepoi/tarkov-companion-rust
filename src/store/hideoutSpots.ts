/**
 * Hideout tab: where the player moved stations on the floor plan ("Move stations"), keyed by
 * the station's normalizedName, in plan coordinates (src/hideout/plan.ts). Shared by PvP and PvE:
 * the bunker is the same building in both.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Pt } from '../hideout/plan'
import { guarded } from './guarded'

interface HideoutSpotsState {
  spots: Record<string, Pt>
  move: (name: string, at: Pt) => void
  reset: () => void
}

export function parseSpots(v: unknown): Record<string, Pt> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out: Record<string, Pt> = {}
  for (const [name, at] of Object.entries(v as Record<string, unknown>)) {
    if (name === 'prototype' || Object.hasOwn(Object.prototype, name)) continue
    if (Array.isArray(at) && at.length === 2 && at.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 1000)) out[name] = [at[0], at[1]]
  }
  return out
}

export const useHideoutSpots = create<HideoutSpotsState>()(
  persist(
    (set) => ({
      spots: {},
      move: (name, at) => set((s) => ({ spots: { ...s.spots, [name]: at } })),
      reset: () => set({ spots: {} }),
    }),
    { name: 'tarkov-companion-hideout-spots', version: 1, ...guarded<HideoutSpotsState>({ spots: (v) => parseSpots(v) }) },
  ),
)

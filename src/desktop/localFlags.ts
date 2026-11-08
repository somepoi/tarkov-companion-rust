/**
 * "Setup done" and "past logs read" are stored next to the quest progress (the
 * renderer's localStorage), not in the main process's settings.json.
 *
 * Progress is scoped to the WebView origin. Keeping the flags with it gives
 * a fresh progress store its own setup and catch-up state.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { guarded } from '../store/guarded'

interface LocalFlags {
  setupDone: boolean
  backfillDone: boolean
  setSetupDone: (v: boolean) => void
  setBackfillDone: (v: boolean) => void
}

export const useLocalFlags = create<LocalFlags>()(
  persist(
    (set) => ({
      setupDone: false,
      backfillDone: false,
      setSetupDone: (setupDone) => set({ setupDone }),
      setBackfillDone: (backfillDone) => set({ backfillDone }),
    }),
    { name: 'tarkov-companion-desktop-flags', version: 1, ...guarded<LocalFlags>({ setupDone: 'boolean', backfillDone: 'boolean' }) },
  ),
)

/** True when this progress store already holds completed quests in either mode. */
export function hasAnyProgress(profiles: Record<string, { completedTaskIds: Set<string> }>): boolean {
  return Object.values(profiles).some((p) => p.completedTaskIds.size > 0)
}

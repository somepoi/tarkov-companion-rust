import { create } from 'zustand'
import type { WipeEvent } from '../shared/desktop-api'
import { useArchivesStore } from '../store/archives'
import { useInventoryStore } from '../store/inventory'
import { useProgressStore } from '../store/progress'
import { useStoryStore } from '../store/story'

interface WipeBannerState {
  event: WipeEvent | null
  show: (e: WipeEvent) => void
  dismiss: () => void
}

/** One-time banner state (not persisted: the main process only reports a wipe once). */
export const useWipeBannerStore = create<WipeBannerState>()((set) => ({
  event: null,
  show: (event) => set({ event }),
  dismiss: () => set({ event: null }),
}))

/** Archives current progress and resets both profiles' quest state, collected items and hideout levels. */
export function archiveAndReset(label: string) {
  const progress = useProgressStore.getState()
  useArchivesStore.getState().add(label, progress.exportProgress())
  const fresh = progress.exportProgress()
  for (const mode of ['regular', 'pve'] as const) {
    fresh.profiles[mode] = { ...fresh.profiles[mode], completedTaskIds: [], activeTaskIds: [], failedTaskIds: [], playerLevel: 1,
      objectiveProgress: {}, objectiveProgressReview: undefined }
  }
  progress.importProgress(fresh)
  const inv = useInventoryStore.getState()
  for (const mode of ['regular', 'pve'] as const) {
    for (const itemId of Object.keys(inv.byMode[mode].collected)) inv.setCollected(mode, itemId, 0)
    for (const stationId of Object.keys(inv.byMode[mode].stationLevels)) inv.setStationLevel(mode, stationId, 0)
  }
  // Story chapters restart with the wipe too.
  useStoryStore.getState().resetAll()
}

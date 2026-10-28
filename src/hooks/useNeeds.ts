import { useMemo } from 'react'
import { useGameData, useHideout, useItems } from '../api/hooks'
import { computeNeeds, type ItemNeed } from '../lib/needs'
import { useModeInventory } from '../store/inventory'
import { useProfile } from '../store/progress'
import type { TrackedNeedCoverage } from '../lib/recommendationSafety'

/** Item needs for the active mode (quests and hideout), plus the queries they depend on. */
export function useNeeds() {
  const gameData = useGameData()
  const hideout = useHideout()
  const items = useItems()
  const profile = useProfile()
  const inventory = useModeInventory()

  const needs = useMemo<Map<string, ItemNeed>>(() => {
    if (!gameData.data) return new Map()
    return computeNeeds({
      tasks: gameData.data.tasks,
      completedTaskIds: profile.completedTaskIds,
      objectiveProgress: profile.objectiveProgress,
      activeTaskIds: profile.activeTaskIds,
      failedTaskIds: profile.failedTaskIds,
      faction: profile.faction,
      stations: hideout.data ?? [],
      stationLevels: inventory.stationLevels,
      // The Crafts tab is gone (2.5.0), so favourite crafts no longer count.
      crafts: [],
      favoriteCraftIds: [],
      items: items.data?.items,
    })
  }, [gameData.data, profile.completedTaskIds, profile.objectiveProgress, profile.activeTaskIds, profile.failedTaskIds, profile.faction, hideout.data, inventory.stationLevels, items.data])

  const coverage = useMemo<TrackedNeedCoverage>(() => {
    const unavailable = [
      !gameData.data || gameData.isError ? 'quests' : null,
      !hideout.data || hideout.isError ? 'hideout' : null,
      !items.data || items.isError ? 'item catalog' : null,
      profile.objectiveProgressReview !== undefined ? 'partial objective progress' : null,
    ].filter((name): name is string => name !== null)
    return unavailable.length
      ? { loaded: false, detail: `Review needed: ${unavailable.join(', ')} data is loading or unavailable. Do not treat missing requirements as surplus.` }
      : { loaded: true, detail: 'Known quest and hideout checklist data is loaded. Crafts, barters, personal reserves and unstructured quest requirements are not fully covered.' }
  }, [gameData.data, gameData.isError, hideout.data, hideout.isError, items.data, items.isError, profile.objectiveProgressReview])

  return { needs, coverage, gameData, hideout, items, inventory, loading: gameData.isPending || hideout.isPending || items.isPending }
}

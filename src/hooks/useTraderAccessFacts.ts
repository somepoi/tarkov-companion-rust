import { useMemo } from 'react'
import { useProgressContext } from './useProgressContext'
import { useModeInventory } from '../store/inventory'
import { useProfile } from '../store/progress'
import type { TraderAccessFacts } from '../lib/traderAccess'

/**
 * The one set of trader-access facts every surface judges offers with.
 *
 * Loyalty must be the same number the Traders panel shows: the level your quests'
 * player level and reputation already reach, raised by a level you set by hand —
 * not the hand-set value alone. Judging only the manual value would tell a
 * player who never touched the Traders panel that they can buy nothing, while
 * the panel next to it displays LL2.
 *
 * Completion likewise uses the deduced set, so an unlock quest the app can infer
 * from later progress counts as done, matching the quest screens.
 *
 * While the catalogs are still loading the computed view is null; the manual
 * levels and explicitly ticked quests are still real facts, so they are used
 * rather than inventing or discarding anything.
 */
export function useTraderAccessFacts(): TraderAccessFacts {
  const progress = useProgressContext()
  const inventory = useModeInventory()
  const profile = useProfile()
  const levels = progress?.traderLevel ?? inventory.traderLevels
  const completedTaskIds = progress?.completed ?? profile.completedTaskIds
  return useMemo(() => ({ levels, completedTaskIds }), [levels, completedTaskIds])
}

import { useMemo } from 'react'
import type { ItemsBundle } from '../api/types'
import { useProgressContext } from './useProgressContext'
import { useProgressStore } from '../store/progress'
import type { FleaRulesContext } from '../lib/economy'

/**
 * The catalog flea rules plus this character's level: enough to decide whether a
 * purchase is possible at all.
 *
 * This is deliberately narrower than `useFleaFees`. A fee estimate also needs a
 * recorded Intelligence Center / Hideout Management level, so that hook returns
 * null when those are unrecorded. Purchase eligibility does not depend on fee
 * modifiers, and gating a price on them would hide buyable items for an
 * unrelated reason.
 *
 * The level is the one the rest of the app shows: the level you set, or the one
 * your quest XP already reaches, whichever is higher (see `useProgressContext`).
 * While the catalogs are loading that computed view is null, so the stored level
 * is used; if that is not a usable number the context stays null, which callers
 * must treat as "not proven", never as "buyable".
 */
export function useFleaRules(catalog: ItemsBundle | undefined): FleaRulesContext | null {
  const mode = useProgressStore((s) => s.gameMode)
  const stored = useProgressStore((s) => s.profiles[mode].playerLevel)
  const computed = useProgressContext()?.level
  const level = computed ?? stored
  return useMemo(() => {
    if (!catalog || catalog.mode !== mode) return null
    if (!Number.isSafeInteger(level) || level < 0) return null
    return { catalog, playerLevel: level }
  }, [catalog, mode, level])
}

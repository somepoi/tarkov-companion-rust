import { useMemo } from 'react'
import type { ItemsBundle } from '../api/types'
import { useInventoryStore } from '../store/inventory'
import { useProgressStore } from '../store/progress'
import { usePrefs } from '../store/prefs'
import { validFeeModifiers } from '../lib/fleaFees'
import type { MarketFeeContext } from '../lib/economy'

/** Reactive, mode-scoped reference assumptions. No extra request, polling or game access. */
export function useFleaFees(catalog: ItemsBundle | undefined): MarketFeeContext | null {
  const mode = useProgressStore((s) => s.gameMode)
  const playerLevel = useProgressStore((s) => s.profiles[mode].playerLevel)
  const discount = usePrefs((s) => s.fleaFeeDiscount)
  const management = usePrefs((s) => s.fleaFeeManagement[mode])
  const recorded = useInventoryStore((s) => s.byMode[mode].stationLevels['5d484fdf654e7600691aadf8'] ?? 0)
  return useMemo(() => {
    if (!catalog || catalog.mode !== mode || !Number.isSafeInteger(recorded) || recorded < 0) return null
    const intelligenceCenter = discount === 'on' || discount === 'auto' && recorded >= 3 ? 3 : 0
    if (intelligenceCenter === 3 && management === null) return null
    const modifiers = { intelligenceCenter, hideoutManagement: intelligenceCenter === 3 ? management! : 0 }
    return validFeeModifiers(modifiers) ? { catalog, playerLevel, modifiers } : null
  }, [catalog, mode, playerLevel, recorded, discount, management])
}

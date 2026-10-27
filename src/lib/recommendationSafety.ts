import type { ItemNeed } from './needs'

export interface TrackedNeedCoverage {
  /** These are the existing checklist sources, not a complete stash-planning catalog. */
  loaded: boolean
  detail: string
}

export interface TrackedItemAdvice {
  kind: 'KEEP' | 'REVIEW'
  label: string
  detail: string
}

/**
 * Aggregate checklist counts cannot prove a physical item is surplus. Keep known
 * requirements protected even when the checklist says nothing more to collect.
 * This intentionally has no SELL result until physical stock can be allocated.
 */
export function trackedItemAdvice(
  need: ItemNeed | undefined,
  coverage: TrackedNeedCoverage,
  reviewReason?: string,
): TrackedItemAdvice {
  if (!coverage.loaded) return { kind: 'REVIEW', label: 'REVIEW — requirements unavailable', detail: coverage.detail }
  if (reviewReason) return { kind: 'REVIEW', label: 'REVIEW — verify screenshot', detail: reviewReason }
  if (need?.quantityUnknown || (need?.unknownFir ?? 0) > 0) {
    return { kind: 'REVIEW', label: 'REVIEW — requirement details unknown', detail: 'A tracked requirement has an unknown amount or FIR condition. Check its source before deciding what to keep.' }
  }
  if (need && need.total > 0) {
    return { kind: 'KEEP', label: 'KEEP — tracked requirement', detail: 'Items already counted may be reserved for these requirements. Nothing more to collect does not mean those items are surplus.' }
  }
  return {
    kind: 'REVIEW',
    label: 'No additional tracked need',
    detail: 'This checklist does not establish saleable surplus. Check other quests, crafts, barters, personal reserves and the item’s FIR status before selling.',
  }
}

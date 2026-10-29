import type { ItemsById } from '../api/types'
import { quantityFitsCatalog } from '../scan/quantity'
import type { Stack } from './client'

export function joinedShapeFits(output: Stack, items: ItemsById | undefined): boolean {
  const item = items?.[output.itemId ?? '']
  return !output.itemId || !!item && (output.location.rotated
    ? item.height === output.location.width && item.width === output.location.height
    : item.width === output.location.width && item.height === output.location.height)
}

export function validJoinedFacts(output: Stack, items: ItemsById | undefined): boolean {
  return joinedShapeFits(output, items) && (!output.provenance.quantityConfirmed
    || quantityFitsCatalog(output.quantity, items?.[output.itemId ?? '']))
}

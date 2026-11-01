import type { ItemsById, RawItem } from './types'

/** JSON provider's explicit any-dogtag group, never a physical weapon preset. */
export const ANY_DOGTAG_ID = 'customdogtags12345678910'
export const PLANNING_CATALOG_SCHEMA = 2

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 512

/** A failed group retains null metadata; dropping bad members would widen certainty. */
export function adaptDogtagAlternatives(raw: RawItem, items: Record<string, RawItem>): string[] | null | undefined {
  if (raw.id !== ANY_DOGTAG_ID) return undefined
  const members = raw.containsItems
  if (!Array.isArray(members) || !members.length || members.length > 256) return null
  const ids = new Set<string>()
  for (const member of members) {
    if (!record(member) || !validId(member.item) || member.item === ANY_DOGTAG_ID
      || member.count !== 1 || !record(member.attributes) || Object.keys(member.attributes).length) return null
    const item = Object.hasOwn(items, member.item) ? items[member.item] : undefined
    if (!item || item.id !== member.item || !Array.isArray(item.types) || item.types.includes('preset')
      || !Array.isArray(item.containsItems) || item.containsItems.length || ids.has(member.item)) return null
    ids.add(member.item)
  }
  return [...ids].sort()
}

/** Do not expand ordinary presets, faction IDs or visually similar variants. */
export function planningItemAlternatives(itemId: string, items: ItemsById): { ids: string[]; gap?: string } {
  if (itemId !== ANY_DOGTAG_ID) return { ids: [itemId] }
  const group = Object.hasOwn(items, itemId) ? items[itemId] : undefined
  const ids = group?.dogtagAlternatives
  if (!Array.isArray(ids) || !ids.length || ids.length > 256 || new Set(ids).size !== ids.length
    || ids.some((id) => !validId(id) || id === ANY_DOGTAG_ID || !Object.hasOwn(items, id)
      || !Array.isArray(items[id].types) || items[id].types.includes('preset')))
    return { ids: [], gap: 'Any-dogtag membership is unavailable or invalid; refresh the item catalog' }
  return { ids: [...ids] }
}

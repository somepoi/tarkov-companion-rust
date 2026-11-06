/**
 * What the stash sell list keeps back: the needs (quests, Collector, hideout) count as many as are
 * still wanted, the other choices keep every item of that kind. No runtime imports, so the search
 * bar's settings store can check saved choices without loading the needs logic.
 */
import type { Item } from '../api/types'
import type { NeedSource } from '../lib/needs'

/** What the sell list keeps back (checkboxes on the search bar's Values panel). */
export type KeepKind = 'quest' | 'collector' | 'hideout' | 'keys' | 'ammo' | 'meds' | 'food' | 'guns' | 'mods' | 'gear' | 'containers' | 'starred'

/** Item types (tarkov.dev `types`) behind each "keep all of these" choice. */
const TYPE_KINDS: { id: KeepKind; types: string[] }[] = [
  { id: 'keys', types: ['keys'] },
  { id: 'ammo', types: ['ammo', 'ammoBox'] },
  { id: 'meds', types: ['meds', 'injectors'] },
  { id: 'food', types: ['provisions'] },
  { id: 'guns', types: ['gun', 'preset'] },
  { id: 'mods', types: ['mods'] },
  { id: 'gear', types: ['armor', 'armorPlate', 'helmet', 'rig', 'backpack', 'headphones', 'glasses'] },
  { id: 'containers', types: ['container'] },
]

export const KEEP_KINDS: { id: KeepKind; label: string; note: string }[] = [
  { id: 'quest', label: 'Quest hand-ins', note: 'Only as many as quests you have not finished still want' },
  { id: 'collector', label: 'Collector (Kappa)', note: "Fence's Collector quest items, as many as it still wants" },
  { id: 'hideout', label: 'Hideout upgrades', note: 'Only as many as unbuilt hideout levels still want' },
  { id: 'keys', label: 'Keys and keycards', note: 'Every key in the snip' },
  { id: 'ammo', label: 'Ammo', note: 'Rounds and ammo boxes' },
  { id: 'meds', label: 'Meds', note: 'Meds and stims' },
  { id: 'food', label: 'Food and drink', note: 'Every food and drink item' },
  { id: 'guns', label: 'Guns', note: 'Every gun' },
  { id: 'mods', label: 'Weapon parts', note: 'Every weapon part' },
  { id: 'gear', label: 'Armour and gear', note: 'Armour, plates, helmets, rigs, backpacks, headsets, glasses' },
  { id: 'containers', label: 'Cases', note: 'Cases, wallets, key tools' },
  { id: 'starred', label: 'Starred items', note: 'Items you starred in the search bar' },
]

/** The needs (quests, Collector, hideout) count by default; nothing else is kept back. */
export const DEFAULT_KEEP: KeepKind[] = ['quest', 'collector', 'hideout']
export const KEEP_KIND_IDS = KEEP_KINDS.map((k) => k.id)

/** Which checkbox a need belongs to. */
export function needKind(s: NeedSource): KeepKind {
  return s.kind === 'quest' ? (s.name === 'Collector' ? 'collector' : 'quest') : 'hideout'
}

/** The "keep all of these" choice an item falls under, if one is ticked. */
export function keptKind(item: Item | undefined, kinds: ReadonlySet<KeepKind>, starred: ReadonlySet<string> = new Set()): KeepKind | null {
  if (!item) return null
  if (kinds.has('starred') && starred.has(item.id)) return 'starred'
  for (const k of TYPE_KINDS) if (kinds.has(k.id) && k.types.some((t) => item.types?.includes(t))) return k.id
  return null
}

export const keepLabel = (k: KeepKind) => KEEP_KINDS.find((x) => x.id === k)?.label ?? k

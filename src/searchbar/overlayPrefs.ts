/**
 * Everything you can tweak on the search bar over the game, in one store (localStorage
 * `tc-overlay-prefs`, this PC only). Every field is checked when read, so a bad value can never
 * break the bar.
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { cleanBoxes, type BoxPos } from './boxes'
import { DEFAULT_KEEP, KEEP_KIND_IDS, type KeepKind } from '../scan/keepKinds'

/** Map layers the bar can draw (its own choice, separate from the Maps tab). */
export type OverlayLayer =
  | 'quests'
  | 'extractsPmc'
  | 'extractsScav'
  | 'transits'
  | 'locks'
  | 'bosses'
  | 'guards'
  | 'snipers'
  | 'pmcSpawns'
  | 'scavSpawns'
  | 'containers'
  | 'valuables'
  | 'needed'
  | 'hazards'
  | 'switches'
  | 'stationary'
  | 'btr'

export const LAYER_INFO: { id: OverlayLayer; label: string; hint: string; group: 'Map' | 'Spawns' | 'Loot' }[] = [
  { id: 'quests', label: 'Ticked quests', hint: 'Spots of the quests ticked "On map"', group: 'Map' },
  { id: 'extractsPmc', label: 'PMC extracts', hint: 'PMC and shared extracts', group: 'Map' },
  { id: 'extractsScav', label: 'Scav extracts', hint: 'Scav extracts', group: 'Map' },
  { id: 'transits', label: 'Transits', hint: 'Transits to other maps', group: 'Map' },
  { id: 'locks', label: 'Locked doors', hint: 'Every locked door and container with its key (red = you do not own it)', group: 'Map' },
  { id: 'hazards', label: 'Hazards', hint: 'Minefields, sniper zones and other danger areas', group: 'Map' },
  { id: 'switches', label: 'Switches and levers', hint: 'Power switches, extract levers, elevator and alarm buttons', group: 'Map' },
  { id: 'stationary', label: 'Mounted guns', hint: 'Stationary machine guns and grenade launchers', group: 'Map' },
  { id: 'btr', label: 'BTR stops', hint: 'Where the BTR taxi stops (Woods, Streets)', group: 'Map' },
  { id: 'bosses', label: 'Bosses', hint: 'Exact spawn points of bosses, cultists, raiders, rogues and the Goons, with chances', group: 'Spawns' },
  { id: 'guards', label: 'Boss guards', hint: 'Guards drawn around each boss', group: 'Spawns' },
  { id: 'snipers', label: 'Sniper scavs', hint: 'Sniper scav spawn points', group: 'Spawns' },
  { id: 'pmcSpawns', label: 'PMC spawns', hint: 'Where PMCs start the raid', group: 'Spawns' },
  { id: 'scavSpawns', label: 'Scav spawns', hint: 'Where scavs (and player scavs) start', group: 'Spawns' },
  { id: 'valuables', label: 'Valuable loose loot', hint: 'Spots where an item worth at least your minimum can lie', group: 'Loot' },
  { id: 'needed', label: 'Loot you still need', hint: 'Spots where items your quests or hideout still need can lie', group: 'Loot' },
  { id: 'containers', label: 'Containers', hint: 'Safes, weapon boxes, jackets and other containers (pick types in the Loot tab)', group: 'Loot' },
]

export type MapTab = 'quests' | 'extracts' | 'bosses' | 'locks' | 'loot' | 'layers'

export interface Ref {
  kind: 'item' | 'quest' | 'map' | 'trader' | 'boss' | 'station'
  id: string
  label: string
}

export interface OverlayPrefs {
  /** See-through at rest / with a map or panels open (percent). */
  idle: number
  map: number
  /** Size of everything (percent). */
  scale: number
  /** Size of map markers (percent). */
  markerScale: number
  /** Extracts list: all, or only those you can use as PMC / as a scav. */
  extractSide: 'all' | 'pmc' | 'scav'
  /** Map area size in pixels (before scaling). */
  mapW: number
  mapH: number
  /** Width of the list beside the map, and of side panels. */
  sideW: number
  panelW: number
  sidebar: boolean
  tab: MapTab
  layers: Record<OverlayLayer, boolean>
  /** Valuable loot: minimum roubles, and whether that is per inventory slot. */
  lootMin: number
  lootPerSlot: boolean
  /** Container types switched off (by name). */
  containersOff: string[]
  /** The little info pills next to the glass. */
  stripRaid: boolean
  stripClock: boolean
  stripScav: boolean
  stripStory: boolean
  stripRestock: boolean
  /** The camera button next to the glass (stash scan). */
  scanButton: boolean
  /** Open the raid's map when a raid starts; show your screenshot position on it. */
  autoRaidMap: boolean
  followPosition: boolean
  /** Open the last map again on the next start. */
  restoreMap: boolean
  lastMapKey: string | null
  recent: Ref[]
  stars: Ref[]
  /** Boxes (cards, the map, side panels) moved or resized by hand, by box id (boxes.ts). */
  boxes: Record<string, BoxPos>
  /** Stash snip: what the sell list keeps back, whether that list of checkboxes is open, picture height. */
  keep: KeepKind[]
  keepOpen: boolean
  snipH: number
}

export const DEFAULT_LAYERS: Record<OverlayLayer, boolean> = {
  quests: true,
  extractsPmc: true,
  extractsScav: false,
  transits: true,
  locks: false,
  hazards: false,
  switches: false,
  stationary: false,
  btr: false,
  bosses: false,
  guards: false,
  snipers: false,
  pmcSpawns: false,
  scavSpawns: false,
  valuables: false,
  needed: false,
  containers: false,
}

/** Older bars kept a few choices under their own keys; start from those. */
function legacy(): Partial<OverlayPrefs> {
  try {
    const out: Partial<OverlayPrefs> = {}
    const look = JSON.parse(localStorage.getItem('tc-searchbar-look') ?? 'null') as { idle?: number; map?: number } | null
    if (look?.idle) out.idle = look.idle
    if (look?.map) out.map = look.map
    const side = localStorage.getItem('tc-searchbar-sidebar')
    if (side !== null) out.sidebar = side !== '0'
    if (localStorage.getItem('tc-searchbar-tall-map') === '1') out.mapH = 416
    const tab = localStorage.getItem('tc-searchbar-map-tab')
    if (tab === 'extracts' || tab === 'bosses') out.tab = tab
    return out
  } catch {
    return {}
  }
}

export const DEFAULT_PREFS: OverlayPrefs = {
  idle: 45,
  map: 80,
  scale: 100,
  markerScale: 100,
  extractSide: 'all',
  mapW: 356,
  mapH: 288,
  sideW: 208,
  panelW: 300,
  sidebar: true,
  tab: 'quests',
  layers: DEFAULT_LAYERS,
  lootMin: 50_000,
  lootPerSlot: false,
  containersOff: [],
  stripRaid: true,
  stripClock: true,
  stripScav: true,
  stripStory: true,
  stripRestock: false,
  scanButton: true,
  autoRaidMap: true,
  followPosition: true,
  restoreMap: false,
  lastMapKey: null,
  recent: [],
  stars: [],
  boxes: {},
  keep: DEFAULT_KEEP,
  keepOpen: true,
  snipH: 224,
}

export const LIMITS = {
  idle: [10, 100],
  map: [10, 100],
  scale: [60, 160],
  markerScale: [60, 200],
  mapW: [240, 900],
  mapH: [180, 900],
  sideW: [160, 360],
  panelW: [240, 520],
  lootMin: [0, 10_000_000],
  snipH: [100, 1400],
} as const

const clamp = (v: unknown, [lo, hi]: readonly [number, number], d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const refs = (v: unknown, max: number): Ref[] =>
  Array.isArray(v)
    ? v
        .filter((r): r is Ref => Boolean(r) && typeof r.id === 'string' && typeof r.label === 'string' && ['item', 'quest', 'map', 'trader', 'boss', 'station'].includes(r.kind))
        .slice(0, max)
        .map((r) => ({ kind: r.kind, id: r.id.slice(0, 80), label: r.label.slice(0, 120) }))
    : []

/** Every field checked; unknown or broken values fall back to the defaults. */
export function cleanOverlayPrefs(raw: unknown): OverlayPrefs {
  const p = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof OverlayPrefs, unknown>>
  const d = DEFAULT_PREFS
  const layers = { ...DEFAULT_LAYERS }
  const rawLayers = (p.layers && typeof p.layers === 'object' ? p.layers : {}) as Record<string, unknown>
  for (const k of Object.keys(DEFAULT_LAYERS) as OverlayLayer[]) if (typeof rawLayers[k] === 'boolean') layers[k] = rawLayers[k] as boolean
  return {
    idle: clamp(p.idle, LIMITS.idle, d.idle),
    map: clamp(p.map, LIMITS.map, d.map),
    scale: clamp(p.scale, LIMITS.scale, d.scale),
    markerScale: clamp(p.markerScale, LIMITS.markerScale, d.markerScale),
    extractSide: p.extractSide === 'pmc' || p.extractSide === 'scav' ? p.extractSide : 'all',
    mapW: clamp(p.mapW, LIMITS.mapW, d.mapW),
    mapH: clamp(p.mapH, LIMITS.mapH, d.mapH),
    sideW: clamp(p.sideW, LIMITS.sideW, d.sideW),
    panelW: clamp(p.panelW, LIMITS.panelW, d.panelW),
    sidebar: bool(p.sidebar, d.sidebar),
    tab: p.tab === 'extracts' || p.tab === 'bosses' || p.tab === 'locks' || p.tab === 'loot' || p.tab === 'layers' ? p.tab : 'quests',
    layers,
    lootMin: clamp(p.lootMin, LIMITS.lootMin, d.lootMin),
    lootPerSlot: bool(p.lootPerSlot, d.lootPerSlot),
    containersOff: Array.isArray(p.containersOff) ? p.containersOff.filter((s): s is string => typeof s === 'string').slice(0, 200) : [],
    stripRaid: bool(p.stripRaid, d.stripRaid),
    stripClock: bool(p.stripClock, d.stripClock),
    stripScav: bool(p.stripScav, d.stripScav),
    stripStory: bool(p.stripStory, d.stripStory),
    stripRestock: bool(p.stripRestock, d.stripRestock),
    scanButton: bool(p.scanButton, d.scanButton),
    autoRaidMap: bool(p.autoRaidMap, d.autoRaidMap),
    followPosition: bool(p.followPosition, d.followPosition),
    restoreMap: bool(p.restoreMap, d.restoreMap),
    lastMapKey: typeof p.lastMapKey === 'string' && /^[a-z0-9-]{1,40}$/.test(p.lastMapKey) ? p.lastMapKey : null,
    recent: refs(p.recent, 10),
    stars: refs(p.stars, 40),
    boxes: cleanBoxes(p.boxes),
    keep: Array.isArray(p.keep) ? KEEP_KIND_IDS.filter((k) => (p.keep as unknown[]).includes(k)) : DEFAULT_KEEP,
    keepOpen: bool(p.keepOpen, d.keepOpen),
    snipH: clamp(p.snipH, LIMITS.snipH, d.snipH),
  }
}

interface OverlayStore extends OverlayPrefs {
  set: (patch: Partial<OverlayPrefs>) => void
  toggleLayer: (id: OverlayLayer, on?: boolean) => void
  toggleContainer: (name: string) => void
  addRecent: (r: Ref) => void
  toggleStar: (r: Ref) => void
  /** A box let go after a move or resize; null forgets it (back next to the glass). */
  setBox: (id: string, pos: BoxPos | null) => void
  reset: (part: 'look' | 'size' | 'all' | 'boxes') => void
}

export const useOverlayPrefs = create<OverlayStore>()(
  persist(
    (set, get) => ({
      ...DEFAULT_PREFS,
      ...cleanOverlayPrefs({ ...DEFAULT_PREFS, ...legacy() }),
      set: (patch) => set(cleanOverlayPrefs({ ...pick(get()), ...patch })),
      toggleLayer: (id, on) => set((s) => ({ layers: { ...s.layers, [id]: on ?? !s.layers[id] } })),
      toggleContainer: (name) => set((s) => ({ containersOff: s.containersOff.includes(name) ? s.containersOff.filter((n) => n !== name) : [...s.containersOff, name] })),
      addRecent: (r) => set((s) => ({ recent: [r, ...s.recent.filter((x) => !(x.kind === r.kind && x.id === r.id))].slice(0, 10) })),
      toggleStar: (r) => set((s) => ({ stars: s.stars.some((x) => x.kind === r.kind && x.id === r.id) ? s.stars.filter((x) => !(x.kind === r.kind && x.id === r.id)) : [r, ...s.stars].slice(0, 40) })),
      setBox: (id, pos) =>
        set((s) => {
          const boxes = { ...s.boxes }
          if (pos) boxes[id] = pos
          else delete boxes[id]
          return { boxes: cleanBoxes(boxes) }
        }),
      reset: (part) =>
        set(
          part === 'look'
            ? { idle: DEFAULT_PREFS.idle, map: DEFAULT_PREFS.map, scale: DEFAULT_PREFS.scale, markerScale: DEFAULT_PREFS.markerScale }
            : part === 'size'
              ? { mapW: DEFAULT_PREFS.mapW, mapH: DEFAULT_PREFS.mapH, sideW: DEFAULT_PREFS.sideW, panelW: DEFAULT_PREFS.panelW, boxes: {} }
              : part === 'boxes'
                ? { boxes: {} }
                : { ...DEFAULT_PREFS, recent: get().recent, stars: get().stars },
        ),
    }),
    {
      name: 'tc-overlay-prefs',
      version: 1,
      partialize: (s) => pick(s),
      merge: (persisted, current) => ({ ...current, ...cleanOverlayPrefs({ ...pick(current), ...((persisted as object) ?? {}) }) }),
    },
  ),
)

/** The data fields only (no actions). */
function pick(s: OverlayPrefs): OverlayPrefs {
  const out = {} as Record<string, unknown>
  for (const k of Object.keys(DEFAULT_PREFS)) out[k] = (s as unknown as Record<string, unknown>)[k]
  return out as unknown as OverlayPrefs
}

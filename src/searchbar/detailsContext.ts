import { createContext, useContext } from 'react'
import type { GameData, HideoutStation, Item, ItemsById, Position, Task } from '../api/types'
import type { GuideImage } from '../api/wikiGuide'
import type { ItemNeed } from '../lib/needs'
import type { ProgressContext } from '../lib/progression'
import type { TaskStatus } from '../lib/taskStatus'
import type { MapOption } from '../maps/useMapOptions'
import type { GameMode } from '../api/client'
import type { OverlayLayer, Ref } from './overlayPrefs'
import type { MapPin } from './SearchBarMap'
import type { FleaRulesContext, MarketFeeContext } from '../lib/economy'

/** Something a card or a side panel shows. */
export type View =
  | { kind: 'quest'; id: string }
  | { kind: 'item'; id: string }
  | { kind: 'picture'; image: GuideImage; title: string }
  | { kind: 'questline'; id: string }
  | { kind: 'trader'; id: string }
  | { kind: 'traders' }
  | { kind: 'boss'; id: string }
  | { kind: 'station'; id: string }
  | { kind: 'hideout' }
  | { kind: 'ammo'; id: string }
  | { kind: 'kappa' }
  | { kind: 'lightkeeper' }
  | { kind: 'story'; id: string | null }
  | { kind: 'settings' }
  | { kind: 'help' }
  /** The last stash snip: what was found, and what it is worth (see stashScan.ts). */
  | { kind: 'scanItems' }
  | { kind: 'scanValues' }

/** Side panels show the same things. */
export type Panel = View

export const panelKey = (p: View) => (p.kind === 'picture' ? `picture:${p.image.full}` : 'id' in p ? `${p.kind}:${p.id}` : p.kind)

export interface KeyMap {
  option: MapOption
  pins: MapPin[]
}

/** How a map card opens: zoomed to a quest, with pins, a ringed spot, or some layers switched on. */
export interface MapRequest {
  focus?: string
  pins?: MapPin[]
  title?: string
  spot?: { points: Position[]; label: string; fit?: Position[] }
  layers?: OverlayLayer[]
}

/** What the details need from the search bar (data, progress, and what clicks do). */
export interface DetailsCtx {
  data: GameData
  items: ItemsById | undefined
  feeContext: MarketFeeContext | null
  /** Catalog flea rules plus the character's level; enough to judge a purchase. */
  fleaRules: FleaRulesContext | null
  stations: HideoutStation[]
  statuses: Record<string, TaskStatus>
  /** Done: ticked, or by deduction (a later quest is done or started). */
  completed: ReadonlySet<string>
  /** Levels, reputation and deductions (null while the data loads). */
  progress: ProgressContext | null
  needs: Map<string, ItemNeed>
  collected: Record<string, number>
  ownedKeyIds: ReadonlySet<string>
  stationLevels: Record<string, number>
  traderLevels: Record<string, number>
  mode: GameMode
  onMap: string[]
  tickQuest: (task: Task, on: boolean) => void
  keyMaps: (item: Item) => KeyMap[]
  showKey: (item: Item, k: KeyMap) => void
  /** Opens a map card (by API map id). */
  openMap: (mapId: string, req?: MapRequest) => void
  open: (p: View) => void
  star: (r: Ref) => void
  starred: (kind: Ref['kind'], id: string) => boolean
  traderName: (id: string) => string
}

export const DetailsContext = createContext<DetailsCtx | null>(null)

export function useDetails(): DetailsCtx {
  const c = useContext(DetailsContext)
  if (!c) throw new Error('DetailsContext missing')
  return c
}

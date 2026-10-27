import { lazy, type ComponentType } from 'react'
import { BarChart3, BookOpen, Megaphone, Crosshair, House, KeyRound, LayoutDashboard, Map, Package, ScrollText, Store, type LucideIcon } from 'lucide-react'

/** Sidebar sections, in order. */
export const NAV_GROUPS = [
  { id: 'overview', label: 'Overview' },
  { id: 'quests', label: 'Quests & story' },
  { id: 'raid', label: 'Raid' },
  { id: 'gear', label: 'Gear & hideout' },
  { id: 'trading', label: 'Trading' },
] as const
export type NavGroupId = (typeof NAV_GROUPS)[number]['id']

export interface NavItem {
  path: string
  label: string
  group: NavGroupId
  icon: LucideIcon
  component: ComponentType
  /** Render edge-to-edge with no page padding (used by the map). */
  fullBleed?: boolean
}

/**
 * Pages load the first time they are opened (each is its own file in the build), so start-up
 * only parses the Dashboard plus the shell; the map, flea market and so on follow on demand.
 */
const page = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) =>
  lazy(() => load().then((m) => ({ default: m[name] })))

/**
 * The sidebar tabs, in display order and grouped into sections (NAV_GROUPS). Each entry becomes a route automatically.
 * To add a tab: create a page component and add one line here.
 */
export const NAV_ITEMS: NavItem[] = [
  { path: '/', group: 'overview', label: 'Dashboard', icon: LayoutDashboard, component: page(() => import('../pages/DashboardPage'), 'DashboardPage') },
  { path: '/stats', group: 'overview', label: 'My stats', icon: BarChart3, component: page(() => import('../pages/StatsPage'), 'StatsPage') },
  { path: '/events', group: 'overview', label: 'Events & patches', icon: Megaphone, component: page(() => import('../pages/EventsPage'), 'EventsPage') },
  { path: '/quests', group: 'quests', label: 'Quests', icon: ScrollText, component: page(() => import('../pages/QuestsPage'), 'QuestsPage') },
  { path: '/story', group: 'quests', label: 'Story', icon: BookOpen, component: page(() => import('../pages/StoryPage'), 'StoryPage') },
  { path: '/maps', group: 'raid', label: 'Maps', icon: Map, component: page(() => import('../pages/MapsPage'), 'MapsPage'), fullBleed: true },
  { path: '/keys', group: 'raid', label: 'Keys', icon: KeyRound, component: page(() => import('../pages/KeysPage'), 'KeysPage') },
  { path: '/ammo', group: 'gear', label: 'Ammo', icon: Crosshair, component: page(() => import('../pages/AmmoPage'), 'AmmoPage') },
  { path: '/items', group: 'gear', label: 'Item Collection', icon: Package, component: page(() => import('../pages/ItemCollectionPage'), 'ItemCollectionPage') },
  { path: '/stash', group: 'gear', label: 'Stash Manager', icon: Package, component: page(() => import('../pages/StashManagerPage'), 'StashManagerPage') },
  { path: '/hideout', group: 'gear', label: 'Hideout', icon: House, component: page(() => import('../pages/HideoutPage'), 'HideoutPage') },
  { path: '/flea', group: 'trading', label: 'Flea Market', icon: Store, component: page(() => import('../pages/FleaMarketPage'), 'FleaMarketPage'), fullBleed: true },
]

/** Tabs shown in the sidebar (Settings → General can hide any except the Dashboard). */
export function visibleNav(hidden: string[]): NavItem[] {
  return NAV_ITEMS.filter((i) => i.path === '/' || !hidden.includes(i.path))
}

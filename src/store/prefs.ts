/**
 * App-wide preferences from the Settings page (appearance, general, prices, notifications,
 * maps, scanner). Desktop-only switches that the main process applies (start with Windows,
 * updates, backups kept, …) live in the native settings.json instead (see useDesktop).
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { FONT_IDS, type FontChoice } from '../lib/fonts'

export const THEMES = [
  { id: 'tarkov', label: 'Tarkov', note: 'Warm dark, the default', swatch: ['#0c0c0b', '#1c1c19', '#c7a66b'] },
  { id: 'midnight', label: 'Midnight', note: 'Cool blue-grey', swatch: ['#0b0f14', '#18202b', '#6fa8dc'] },
  { id: 'olive', label: 'Olive drab', note: 'Military green', swatch: ['#0d0f0a', '#1b2016', '#a3b86c'] },
  { id: 'oled', label: 'OLED black', note: 'Pure black, saves power on OLED screens', swatch: ['#000000', '#111111', '#d4b277'] },
  { id: 'crimson', label: 'Crimson', note: 'Dark with a red accent', swatch: ['#0f0b0b', '#201717', '#d0645a'] },
  { id: 'daylight', label: 'Daylight', note: 'Light theme for bright rooms', swatch: ['#f4f1ea', '#ffffff', '#8a6a2f'] },
  { id: 'contrast', label: 'High contrast', note: 'Strongest text contrast', swatch: ['#000000', '#141414', '#ffd34d'] },
  { id: 'labs', label: 'Labs', note: 'Sterile teal, like TerraGroup', swatch: ['#081012', '#132126', '#3fc1c9'] },
  { id: 'desert', label: 'Desert', note: 'Sand and amber', swatch: ['#110e09', '#221c13', '#e0a458'] },
  { id: 'woods', label: 'Woods', note: 'Deep forest green', swatch: ['#080d09', '#132016', '#79c37a'] },
  { id: 'nightvision', label: 'Night vision', note: 'Green phosphor', swatch: ['#020703', '#0b1a0d', '#5cff7a'] },
  { id: 'thermal', label: 'Thermal', note: 'Violet with hot orange', swatch: ['#0d0812', '#1e1428', '#ff8a3d'] },
  { id: 'steel', label: 'Steel', note: 'Neutral grey-blue', swatch: ['#0d0f11', '#1b1f24', '#9fb4c7'] },
  { id: 'lighthouse', label: 'Lighthouse', note: 'Navy and coral', swatch: ['#080c14', '#141c2c', '#ff7a59'] },
  { id: 'cultist', label: 'Cultist', note: 'Dark violet and magenta', swatch: ['#0c0810', '#1c1324', '#c86be0'] },
  { id: 'arctic', label: 'Arctic', note: 'Cool light theme', swatch: ['#eef2f5', '#ffffff', '#2f7fbf'] },
] as const

/** Colours a sidebar tab can be marked with (Settings → General → Sidebar tabs). */
export const TAB_COLORS = [
  { id: 'red', label: 'Red', hex: '#e05252' },
  { id: 'orange', label: 'Orange', hex: '#e38a3a' },
  { id: 'yellow', label: 'Yellow', hex: '#d9b84a' },
  { id: 'green', label: 'Green', hex: '#5cb85c' },
  { id: 'teal', label: 'Teal', hex: '#3fb8af' },
  { id: 'blue', label: 'Blue', hex: '#4a90e2' },
  { id: 'purple', label: 'Purple', hex: '#9b6bd6' },
  { id: 'pink', label: 'Pink', hex: '#d65fa0' },
] as const
export type TabColorId = (typeof TAB_COLORS)[number]['id']
export type ThemeId = (typeof THEMES)[number]['id']

export type Density = 'comfortable' | 'compact'
export type TimeFormat = 'system' | '24h' | '12h'
export type NumberStyle = 'comma' | 'space' | 'dot'
/** How an item's worth is judged (scanner keep/sell, crafts, money makers, needs). */
export type PriceSource = 'best' | 'trader' | 'flea'
export type FleaFeeDiscount = 'auto' | 'on' | 'off'
export type ScanTicking = 'needed' | 'sure' | 'none'

export interface Prefs {
  // Appearance
  theme: ThemeId
  /** Text and controls size, percent. */
  uiScale: number
  fontFamily: FontChoice
  density: Density
  reduceMotion: boolean
  // General
  landingPage: string
  hiddenTabs: string[]
  /** Sidebar tab colours by path (none = the theme's colours). */
  tabColors: Record<string, TabColorId>
  sidebarCollapsed: boolean
  timeFormat: TimeFormat
  numberStyle: NumberStyle
  /** 1.2M instead of 1,200,000 in tight places (tables, tiles). */
  compactPrices: boolean
  confirmDangerous: boolean
  // Prices and data
  priceSource: PriceSource
  fleaFeeDiscount: FleaFeeDiscount
  fleaFeeManagement: { pve: number | null; regular: number | null }
  /** Minutes between price refreshes (the items document). */
  dataRefreshMinutes: number
  /** Hours between checks for new quests and other game content (tasks, maps, traders, hideout, crafts, barters). */
  contentCheckHours: number
  refreshOnFocus: boolean
  // Notifications
  notifications: boolean
  traderRestockLeadMinutes: number
  storyTimerAlerts: boolean
  liveTickToast: boolean
  soundVolume: number
  // Maps
  markerScale: number
  bringBoxOpen: boolean
  /** Desktop: a card with the raid's quests and what they need when the game loads a map. */
  raidBriefing: boolean
  /** Starting reputation the game edition gives every main trader (0, or 0.2 for Prepare for Escape / Edge of Darkness / The Unheard). */
  startingReputation: number
  questPanelOpen: boolean
  showMapCredits: boolean
  // Scanner
  scanTicking: ScanTicking
  scanApplyMode: 'add' | 'replace'
  scanTint: boolean
  // Desktop behaviour handled in the renderer
  autoSwitchGameMode: boolean
  autoTickFromLogs: boolean
  autoBackup: boolean
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'tarkov',
  uiScale: 100,
  fontFamily: 'system',
  density: 'comfortable',
  reduceMotion: false,
  landingPage: '/',
  hiddenTabs: [],
  tabColors: {},
  sidebarCollapsed: false,
  timeFormat: 'system',
  numberStyle: 'comma',
  compactPrices: false,
  confirmDangerous: true,
  priceSource: 'best',
  fleaFeeDiscount: 'auto',
  fleaFeeManagement: { pve: null, regular: null },
  dataRefreshMinutes: 60,
  contentCheckHours: 6,
  refreshOnFocus: true,
  notifications: true,
  traderRestockLeadMinutes: 2,
  storyTimerAlerts: true,
  liveTickToast: true,
  soundVolume: 50,
  markerScale: 100,
  bringBoxOpen: true,
  raidBriefing: true,
  startingReputation: 0,
  questPanelOpen: true,
  showMapCredits: true,
  scanTicking: 'sure',
  scanApplyMode: 'add',
  scanTint: true,
  autoSwitchGameMode: true,
  autoTickFromLogs: true,
  autoBackup: true,
}

/** Allowed values per field: anything else in storage (old versions, hand edits) falls back to the default. */
const clampNum = (lo: number, hi: number) => (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const oneOf = (...xs: readonly unknown[]) => (v: unknown) => xs.includes(v)
const isBool = (v: unknown) => typeof v === 'boolean'
const VALID: { [K in keyof Prefs]: (v: unknown) => boolean } = {
  theme: oneOf(...THEMES.map((t) => t.id)),
  uiScale: clampNum(70, 160),
  fontFamily: oneOf(...FONT_IDS),
  density: oneOf('comfortable', 'compact'),
  reduceMotion: isBool,
  landingPage: (v) => typeof v === 'string' && v.startsWith('/') && v.length < 40,
  hiddenTabs: (v) => Array.isArray(v) && v.length < 40 && v.every((x) => typeof x === 'string'),
  tabColors: (v) => typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length < 40 && Object.values(v).every((c) => TAB_COLORS.some((t) => t.id === c)),
  sidebarCollapsed: isBool,
  timeFormat: oneOf('system', '24h', '12h'),
  numberStyle: oneOf('comma', 'space', 'dot'),
  compactPrices: isBool,
  confirmDangerous: isBool,
  priceSource: oneOf('best', 'trader', 'flea'),
  fleaFeeDiscount: oneOf('auto', 'on', 'off'),
  fleaFeeManagement: (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
    && Object.keys(v).length === 2 && ['pve', 'regular'].every((mode) => {
      const value = (v as Record<string, unknown>)[mode]
      return value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100
    }),
  dataRefreshMinutes: clampNum(15, 24 * 60),
  contentCheckHours: clampNum(1, 24),
  refreshOnFocus: isBool,
  notifications: isBool,
  traderRestockLeadMinutes: clampNum(0, 30),
  storyTimerAlerts: isBool,
  liveTickToast: isBool,
  soundVolume: clampNum(0, 100),
  markerScale: clampNum(60, 200),
  bringBoxOpen: isBool,
  raidBriefing: isBool,
  startingReputation: (v) => v === 0 || v === 0.2,
  questPanelOpen: isBool,
  showMapCredits: isBool,
  scanTicking: oneOf('needed', 'sure', 'none'),
  scanApplyMode: oneOf('add', 'replace'),
  scanTint: isBool,
  autoSwitchGameMode: isBool,
  autoTickFromLogs: isBool,
  autoBackup: isBool,
}

/** Saved preferences with every invalid or missing field replaced by its default. */
export function cleanPrefs(raw: unknown): Prefs {
  const out: Prefs = { ...DEFAULT_PREFS }
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(DEFAULT_PREFS) as (keyof Prefs)[]) {
    const v = (raw as Record<string, unknown>)[key]
    if (v !== undefined && VALID[key](v)) (out as unknown as Record<string, unknown>)[key] = v
  }
  return out
}

interface PrefsState extends Prefs {
  set: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void
  /** Puts every setting back to its default. */
  resetAll: () => void
}

export const usePrefs = create<PrefsState>()(
  persist(
    (set) => ({
      ...DEFAULT_PREFS,
      set: (key, value) => set(VALID[key](value) ? ({ [key]: value } as Partial<PrefsState>) : {}),
      resetAll: () => set({ ...DEFAULT_PREFS }),
    }),
    {
      name: 'tarkov-companion-prefs',
      version: 2,
      partialize: (s) => cleanPrefs(s),
      // v2: the scanner ticks only "Sure" matches by default (v1 also ticked "Likely" ones).
      migrate: (persisted, version) => {
        const p = cleanPrefs(persisted)
        if (version < 2 && p.scanTicking === 'needed') p.scanTicking = 'sure'
        return p
      },
      merge: (persisted, current) => ({ ...current, ...cleanPrefs(persisted) }),
    },
  ),
)

/** Current preferences outside React (formatters, query options). */
export const prefs = (): Prefs => usePrefs.getState()

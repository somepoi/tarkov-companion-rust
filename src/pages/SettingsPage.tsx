import { StagedUpdateCheck } from '../desktop/StagedUpdateCheck'
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  Bell,
  Download,
  Database,
  Gauge,
  Keyboard,
  Info,
  Map as MapIcon,
  Monitor,
  Palette,
  RefreshCw,
  RotateCcw,
  ScanSearch,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Upload,
  Volume2,
  X,
} from 'lucide-react'
import { NAV_GROUPS, NAV_ITEMS } from '../config/nav'

/** A copy of `record` without `key`. */
const withoutKey = <T,>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
import { TAB_COLORS, THEMES, usePrefs, type Prefs } from '../store/prefs'
import { useProgressStore } from '../store/progress'
import { useMapOverlayStore } from '../store/mapOverlay'
import { useTimersStore, beep } from '../desktop/timers'
import { isDesktop, updateDesktopSettings, useDesktopStore } from '../desktop/useDesktop'
import { DesktopSettingsSection, ArchivesSettings } from '../desktop/DesktopSettings'
import { CleanupPanel } from '../desktop/CleanupPanel'
import { HealthAndBackups } from '../desktop/HealthAndBackups'
import { SyncHistorySection } from '../desktop/SyncReview'
import { AboutSection } from '../components/AboutSection'
import { MAX_IMPORT_BYTES, buildProgressFile, importProgressFile, parseImportJson } from '../lib/progressFile'
import { askNotificationPermission, notificationPermission, notify } from '../lib/notify'
import { formatDateTime, formatRoubles } from '../lib/format'
import { JSON_API_BASE } from '../api/client'
import { persister } from '../api/persist'
import type { DesktopSettings, UpdateMode } from '../shared/desktop-api'


// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

const SearchContext = createContext('')

/** Hides itself when the search box has text that matches neither the title nor the keywords. */
function Section({ id, title, icon: Icon, keywords, children, desktopOnly }: { id: string; title: string; icon: typeof Info; keywords: string; children: ReactNode; desktopOnly?: boolean }) {
  const query = useContext(SearchContext)
  if (desktopOnly && !isDesktop()) return null
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const hay = `${title} ${keywords}`.toLowerCase()
  if (words.length && !words.every((w) => hay.includes(w))) return null
  return (
    <section id={id} className="scroll-mt-4 rounded-lg border border-line bg-surface-2">
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
        <Icon className="h-4 w-4 text-accent" aria-hidden /> {title}
      </h2>
      <div className="divide-y divide-line">{children}</div>
    </section>
  )
}

function Row({ label, hint, children, wide }: { label: string; hint?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`flex gap-3 px-4 py-3 ${wide ? 'flex-col' : 'flex-col sm:flex-row sm:items-center sm:justify-between'}`}>
      <div className="min-w-0 sm:max-w-[55%]">
        <div className="text-sm">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-ink-muted">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${checked ? 'border-accent bg-accent/80' : 'border-line bg-surface-3'}`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-ink shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="inline-flex flex-wrap rounded border border-line bg-surface p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${value === o.value ? 'bg-accent text-surface' : 'text-ink-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Slider({ value, min, max, step, onChange, label, unit = '%' }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; unit?: string }) {
  return (
    <div className="flex items-center gap-2">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(e.target.valueAsNumber)} aria-label={label} className="w-40 accent-[var(--color-accent)]" />
      <span className="w-12 text-right text-xs tabular-nums text-ink-muted">
        {value}
        {unit}
      </span>
    </div>
  )
}

function Select<T extends string | number>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <select
      value={String(value)}
      aria-label={label}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value)
        if (o) onChange(o.value)
      }}
      className="rounded border border-line bg-surface px-2 py-1.5 text-sm"
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

/** One preference bound to the prefs store. */
function usePref<K extends keyof Prefs>(key: K): [Prefs[K], (v: Prefs[K]) => void] {
  const value = usePrefs((s) => s[key])
  const set = usePrefs((s) => s.set)
  return [value, (v) => set(key, v)]
}

function useDesktopSetting<K extends keyof DesktopSettings>(key: K, fallback: DesktopSettings[K]): [DesktopSettings[K], (v: DesktopSettings[K]) => void] {
  const value = useDesktopStore((s) => s.settings?.[key]) ?? fallback
  return [value, (v) => void updateDesktopSettings({ [key]: v } as Partial<DesktopSettings>).catch(() => undefined)]
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function AppearanceSection() {
  const [theme, setTheme] = usePref('theme')
  const [uiScale, setUiScale] = usePref('uiScale')
  const [density, setDensity] = usePref('density')
  const [reduceMotion, setReduceMotion] = usePref('reduceMotion')
  return (
    <Section id="appearance" title="Appearance" icon={Palette} keywords="theme colour color dark light contrast oled text size font zoom density compact motion animation">
      <Row label="Theme" hint="Colours for the whole app. Maps keep their own imagery." wide>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              aria-pressed={theme === t.id}
              className={`rounded-lg border p-2 text-left transition-colors ${theme === t.id ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-ink-dim'}`}
            >
              <div className="flex h-10 overflow-hidden rounded border border-black/20">
                <span className="flex-1" style={{ background: t.swatch[0] }} />
                <span className="flex-1" style={{ background: t.swatch[1] }} />
                <span className="w-4" style={{ background: t.swatch[2] }} />
              </div>
              <div className="mt-1.5 text-xs font-semibold">{t.label}</div>
              <div className="text-[11px] text-ink-muted">{t.note}</div>
            </button>
          ))}
        </div>
      </Row>
      <Row label="Text size" hint="Makes all text and controls bigger or smaller.">
        <div className="flex items-center gap-2">
          <Slider value={uiScale} min={80} max={140} step={5} onChange={setUiScale} label="Text size" />
          {uiScale !== 100 && (
            <button type="button" onClick={() => setUiScale(100)} className="text-xs text-accent underline">
              Reset
            </button>
          )}
        </div>
      </Row>
      <Row label="Density" hint="Compact fits more rows on screen.">
        <Segmented value={density} onChange={setDensity} label="Density" options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
      </Row>
      <Row label="Reduce motion" hint="Turns off animations and sliding panels.">
        <Switch checked={reduceMotion} onChange={setReduceMotion} label="Reduce motion" />
      </Row>
    </Section>
  )
}

function GeneralSection() {
  const [landing, setLanding] = usePref('landingPage')
  const [hidden, setHidden] = usePref('hiddenTabs')
  const [tabColors, setTabColors] = usePref('tabColors')
  const [timeFormat, setTimeFormat] = usePref('timeFormat')
  const [numberStyle, setNumberStyle] = usePref('numberStyle')
  const [compactPrices, setCompactPrices] = usePref('compactPrices')
  return (
    <Section id="general" title="General" icon={Settings2} keywords="start page landing tabs sidebar hide colour color coded sections time clock 24 12 hour date number format separator compact prices">
      <Row label="Start page" hint="The tab the app opens on.">
        <Select
          value={landing}
          onChange={setLanding}
          label="Start page"
          options={NAV_ITEMS.filter((i) => !hidden.includes(i.path)).map((i) => ({ value: i.path, label: i.label }))}
        />
      </Row>
      <Row label="Sidebar tabs" hint="Untick tabs you never use to hide them (the Dashboard always stays), and give tabs a colour to find them faster." wide>
        <div className="space-y-3">
          {NAV_GROUPS.map((g) => {
            const inGroup = NAV_ITEMS.filter((t) => t.group === g.id)
            return (
              <div key={g.id}>
                <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">{g.label}</div>
                <ul className="divide-y divide-line rounded border border-line">
                  {inGroup.map((t) => {
                    const always = t.path === '/'
                    const color = tabColors[t.path]
                    const hex = color ? TAB_COLORS.find((c) => c.id === color)?.hex : undefined
                    return (
                      <li key={t.path} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-2.5 py-1.5">
                        <label className="flex min-w-[11rem] flex-1 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={always || !hidden.includes(t.path)}
                            disabled={always}
                            onChange={(e) => {
                              setHidden(e.target.checked ? hidden.filter((p) => p !== t.path) : [...hidden, t.path])
                              if (!e.target.checked && landing === t.path) setLanding('/')
                            }}
                            className="h-4 w-4"
                            aria-label={`Show ${t.label}`}
                          />
                          <t.icon className="h-4 w-4 shrink-0" style={hex ? { color: hex } : undefined} aria-hidden />
                          <span className={!always && hidden.includes(t.path) ? 'text-ink-dim line-through' : ''}>{t.label}</span>
                        </label>
                        <div className="flex items-center gap-1" role="radiogroup" aria-label={`Colour for ${t.label}`}>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={!color}
                            onClick={() => setTabColors(withoutKey(tabColors, t.path))}
                            title="No colour"
                            className={`h-5 w-5 rounded-full border text-[10px] leading-none text-ink-dim ${!color ? 'border-accent ring-1 ring-accent' : 'border-line'}`}
                          >
                            ×
                          </button>
                          {TAB_COLORS.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              role="radio"
                              aria-checked={color === c.id}
                              onClick={() => setTabColors({ ...tabColors, [t.path]: c.id })}
                              title={c.label}
                              className={`h-5 w-5 rounded-full border ${color === c.id ? 'border-ink ring-2 ring-accent' : 'border-black/30'}`}
                              style={{ background: c.hex }}
                            />
                          ))}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
          {Object.keys(tabColors).length > 0 && (
            <button type="button" className="text-xs text-ink-muted underline hover:text-accent" onClick={() => setTabColors({})}>
              Remove all tab colours
            </button>
          )}
        </div>
      </Row>
      <Row label="Clock" hint={`Example: ${formatDateTime(new Date(2026, 9, 7, 21, 30))}`}>
        <Segmented value={timeFormat} onChange={setTimeFormat} label="Clock" options={[{ value: 'system', label: 'Like Windows' }, { value: '24h', label: '24-hour' }, { value: '12h', label: '12-hour' }]} />
      </Row>
      <Row label="Number style" hint={`Example: ${formatRoubles(1234567)}`}>
        <Segmented value={numberStyle} onChange={setNumberStyle} label="Number style" options={[{ value: 'comma', label: '1,234,567' }, { value: 'space', label: '1 234 567' }, { value: 'dot', label: '1.234.567' }]} />
      </Row>
      <Row label="Short prices" hint="Shows big amounts as ₽1.2M instead of ₽1,234,567.">
        <Switch checked={compactPrices} onChange={setCompactPrices} label="Short prices" />
      </Row>
    </Section>
  )
}

function PricesSection() {
  const [source, setSource] = usePref('priceSource')
  const [fee, setFee] = usePref('fleaFeeDiscount')
  const [management, setManagement] = usePref('fleaFeeManagement')
  const gameMode = useProgressStore((s) => s.gameMode)
  const [refresh, setRefresh] = usePref('dataRefreshMinutes')
  const [content, setContent] = usePref('contentCheckHours')
  const [onFocus, setOnFocus] = usePref('refreshOnFocus')
  const queryClient = useQueryClient()
  const [note, setNote] = useState<string | null>(null)
  return (
    <Section id="prices" title="Prices & game data" icon={Database} keywords="price flea trader sell buy value fee intelligence center refresh update data cache offline tarkov.dev new quests content patch check interval">
      <Row label="Value items by" hint="Used for estimated item values on the flea and ammo tabs. Best = whichever pays more (selling) or costs less (buying).">
        <Segmented value={source} onChange={setSource} label="Value items by" options={[{ value: 'best', label: 'Best of both' }, { value: 'trader', label: 'Traders' }, { value: 'flea', label: 'Flea market' }]} />
      </Row>
      <Row label="Lower flea fees (Intelligence Center 3)" hint="Automatic uses the recorded Hideout level; an unrecorded level means a no-discount scenario. Yes/No forces the discount scenario. Stash references use their own confirmed levels.">
        <Segmented value={fee} onChange={setFee} label="Flea fee discount" options={[{ value: 'auto', label: 'Automatic' }, { value: 'on', label: 'Yes' }, { value: 'off', label: 'No' }]} />
      </Row>
      <Row label={`Hideout Management level · ${gameMode === 'pve' ? 'PvE' : 'PvP'}`} hint="Enter your current skill level for discounted catalog references. Blank means unknown and hides discounted net estimates. Saved separately for PvE/PvP; the supported calculation range is 0–100.">
        <input type="number" min={0} max={100} step={1} aria-label="Hideout Management skill level for fee estimates"
          className="w-24 rounded border border-line bg-surface px-2 py-1.5 text-sm"
          value={management[gameMode] ?? ''}
          onChange={(event) => { const value = event.target.valueAsNumber; if (event.target.value === '') setManagement({ ...management, [gameMode]: null }); else if (Number.isSafeInteger(value) && value >= 0 && value <= 100) setManagement({ ...management, [gameMode]: value }) }} />
      </Row>
      <Row label="Check for new quests and content every" hint="Quests, maps, traders and hideout from tarkov.dev. New quests only come with game patches, so a few checks a day are enough; also checked at every start. Unchanged data is not downloaded again. Trader restock times and the Goons' map stay up to date while those screens are open.">
        <Select
          value={content}
          onChange={setContent}
          label="Content check interval"
          options={[
            { value: 1, label: '1 hour' },
            { value: 3, label: '3 hours' },
            { value: 6, label: '6 hours (recommended)' },
            { value: 12, label: '12 hours' },
            { value: 24, label: 'Once a day' },
          ]}
        />
      </Row>
      <Row label="Refresh prices every" hint="Flea and trader prices (the large item list). Shorter means fresher prices but more downloads; the Flea Market tab refreshes faster while it is open.">
        <Select
          value={refresh}
          onChange={setRefresh}
          label="Refresh interval"
          options={[
            { value: 15, label: '15 minutes' },
            { value: 30, label: '30 minutes' },
            { value: 60, label: '1 hour' },
            { value: 180, label: '3 hours' },
            { value: 360, label: '6 hours' },
            { value: 1440, label: 'Once a day' },
          ]}
        />
      </Row>
      <Row label="Refresh when coming back to the app" hint="Checks for newer data when you switch back to the window (only once it is older than the interval above).">
        <Switch checked={onFocus} onChange={setOnFocus} label="Refresh on focus" />
      </Row>
      <Row label="Refresh now" hint={<>Source: <code className="text-ink">{JSON_API_BASE}</code>. {note}</>}>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void queryClient.invalidateQueries()
              setNote('Refreshing in the background…')
            }}
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
          <button
            type="button"
            className="btn"
            title="Deletes the offline copy of tarkov.dev data and downloads it again. Your progress is not touched."
            onClick={async () => {
              queryClient.clear()
              await Promise.resolve(persister.removeClient()).catch(() => undefined)
              void queryClient.invalidateQueries()
              setNote('Cached game data cleared; downloading a fresh copy.')
            }}
          >
            <Trash2 className="h-4 w-4" /> Clear cache
          </button>
        </div>
      </Row>
    </Section>
  )
}

function NotificationsSection() {
  const [enabled, setEnabled] = usePref('notifications')
  const [lead, setLead] = usePref('traderRestockLeadMinutes')
  const [story, setStory] = usePref('storyTimerAlerts')
  const [raidPrompt, setRaidPrompt] = usePref('raidResultPrompt')
  const [toast, setToast] = usePref('liveTickToast')
  const [volume, setVolume] = usePref('soundVolume')
  const sounds = useTimersStore((s) => s.soundsEnabled)
  const setSounds = useTimersStore((s) => s.setSoundsEnabled)
  const [permission, setPermission] = useState(notificationPermission())
  const permText =
    permission === 'granted' ? 'Allowed' : permission === 'denied' ? 'Blocked (allow it in your browser or Windows settings)' : permission === 'unsupported' ? 'Not supported here' : 'Not asked yet'
  return (
    <Section id="notifications" title="Notifications & sounds" icon={Bell} keywords="notification alert popup trader restock story timer raid result toast sound beep volume">
      <Row label="System notifications" hint={`Pop-ups from Windows or the browser. Permission: ${permText}.`}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn !py-1 text-xs"
            onClick={async () => {
              const p = await askNotificationPermission()
              setPermission(p)
              if (p === 'granted') notify('test', 'Tarkov Companion', { body: 'Notifications work.' })
            }}
          >
            Test
          </button>
          <Switch checked={enabled} onChange={setEnabled} label="System notifications" />
        </div>
      </Row>
      <Row label="Trader restock warning" hint="For traders you put a bell on (Flea Market tab → Traders): how long before the restock.">
        <Select
          value={lead}
          onChange={setLead}
          label="Restock warning"
          options={[
            { value: 0, label: 'At the restock' },
            { value: 1, label: '1 minute before' },
            { value: 2, label: '2 minutes before' },
            { value: 5, label: '5 minutes before' },
            { value: 10, label: '10 minutes before' },
          ]}
        />
      </Row>
      <Row label="Story time gates" hint="A notification when a story chapter's waiting time is over.">
        <Switch checked={story} onChange={setStory} label="Story time gates" />
      </Row>
      {isDesktop() && (
        <>
          <Row label="Ask for the raid result" hint="After each raid, a small card asks how it went (for My stats → Raid log).">
            <Switch checked={raidPrompt} onChange={setRaidPrompt} label="Ask for the raid result" />
          </Row>
          <Row label="Show quests ticked from the game log" hint="A short message with Undo whenever a quest is ticked automatically.">
            <Switch checked={toast} onChange={setToast} label="Show auto-tick messages" />
          </Row>
        </>
      )}
      <Row label="Sounds" hint="A short beep at raid start, when the run-through window passes and when the scav cooldown ends.">
        <div className="flex items-center gap-3">
          {sounds && <Slider value={volume} min={5} max={100} step={5} onChange={setVolume} label="Volume" />}
          <button type="button" className="btn !py-1 text-xs" disabled={!sounds} onClick={() => beep('done')} title="Play the sound">
            <Volume2 className="h-3.5 w-3.5" />
          </button>
          <Switch checked={sounds} onChange={setSounds} label="Sounds" />
        </div>
      </Row>
    </Section>
  )
}

function MapsSection() {
  const [markerScale, setMarkerScale] = usePref('markerScale')
  const [bringOpen, setBringOpen] = usePref('bringBoxOpen')
  const autoUntick = useMapOverlayStore((s) => s.autoUntickCompleted)
  const setAutoUntick = useMapOverlayStore((s) => s.setAutoUntickCompleted)
  const [openOnRaid, setOpenOnRaid] = useDesktopSetting('openMapOnRaid', true)
  const [briefing, setBriefing] = usePref('raidBriefing')
  return (
    <Section id="maps" title="Maps" icon={MapIcon} keywords="map marker size icon bring box untick completed quests raid open briefing">
      <Row label="Marker size" hint="Quest, extract, boss and position markers.">
        <Slider value={markerScale} min={60} max={200} step={10} onChange={setMarkerScale} label="Marker size" />
      </Row>
      <Row label="Untick completed quests" hint="A quest shown on the map disappears from it once it is completed (by you or from the game log).">
        <Switch checked={autoUntick} onChange={setAutoUntick} label="Untick completed quests" />
      </Row>
      <Row label="'What to bring' box starts open" hint="The list in the map's bottom-right corner.">
        <Switch checked={bringOpen} onChange={setBringOpen} label="Bring box open" />
      </Row>
      {isDesktop() && (
        <Row label="Open the map when a raid starts" hint="Jumps to the raid's map as soon as the game loads it.">
          <Switch checked={openOnRaid} onChange={setOpenOnRaid} label="Open map on raid" />
        </Row>
      )}
      {isDesktop() && (
        <Row label="Raid briefing" hint="When the game loads a map: a card with your quests there (ticked on the Maps tab, else started in the game) and the keys and items they need. Started quests are put on the map.">
          <Switch checked={briefing} onChange={setBriefing} label="Raid briefing" />
        </Row>
      )}
    </Section>
  )
}

function ScannerSection() {
  const [ticking, setTicking] = usePref('scanTicking')
  const [applyMode, setApplyMode] = usePref('scanApplyMode')
  const [tint, setTint] = usePref('scanTint')
  return (
    <Section id="scanner" title="Stash scanner" icon={ScanSearch} keywords="scanner screenshot stash tick apply add replace keep sell tint">
      <Row label="Tick automatically" hint='Which recognised items start ticked for adding to Item Collection. By default only "Sure" matches; "Likely" and "Check" ones wait for you to confirm them.'>
        <Segmented
          value={ticking}
          onChange={setTicking}
          label="Tick automatically"
          options={[
            { value: 'sure', label: 'Needed and sure' },
            { value: 'needed', label: 'Needed, also "Likely"' },
            { value: 'none', label: 'Nothing' },
          ]}
        />
      </Row>
      <Row label="Apply as" hint="Add selected counts, or set only the selected item counts. Other items stay unchanged; this does not replace a container.">
        <Segmented value={applyMode} onChange={setApplyMode} label="Apply as" options={[{ value: 'add', label: 'Add' }, { value: 'replace', label: 'Set selected' }]} />
      </Row>
      <Row label="Review highlight" hint="Highlight detected regions to verify identity, quantity and FIR. The checklist does not establish saleable surplus.">
        <Switch checked={tint} onChange={setTint} label="Review highlight" />
      </Row>
    </Section>
  )
}

/** Records a key combination for a global hotkey (Electron accelerator format). */
function HotkeyRecorder({ setting = 'scanHotkey' }: { setting?: 'scanHotkey' | 'searchBarHotkey' | 'searchBarSearchHotkey' | 'searchBarLockHotkey' | 'searchBarMapHotkey' }) {
  const current = useDesktopStore((s) => s.settings?.[setting]) ?? ''
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean) as string[]
      const code = e.code
      const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d{1,2}$/.test(code) ? code : code === 'Space' ? 'Space' : null
      if (!mods.length || !key) {
        setError('Use at least one of Ctrl, Alt or Shift plus a letter, number, F-key or Space.')
        return
      }
      setError(null)
      setRecording(false)
      void updateDesktopSettings({ [setting]: [...mods, key].join('+') }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, setting])
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <kbd className="rounded border border-line bg-surface px-2 py-1 font-mono text-xs">{recording ? 'Press keys… (Esc cancels)' : current || 'Off'}</kbd>
        <button type="button" className="btn !py-1 text-xs" onClick={() => setRecording(true)}>
          <Keyboard className="h-3.5 w-3.5" /> Change
        </button>
        {current && (
          <button type="button" className="btn !py-1 text-xs" onClick={() => void updateDesktopSettings({ [setting]: '' }).catch((cause: unknown) => setError(String(cause)))}>
            Turn off
          </button>
        )}
      </div>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  )
}

function DesktopAppSection() {
  const settingsError = useDesktopStore((s) => s.settingsError)
  const [tray, setTray] = useDesktopSetting('minimizeToTray', true)
  const [startWin, setStartWin] = useDesktopSetting('startWithWindows', false)
  const [startMin, setStartMin] = useDesktopSetting('startMinimized', false)
  const [updates, setUpdates] = useDesktopSetting('updateMode', 'auto' as UpdateMode)
  const [track, setTrack] = useDesktopSetting('trackPosition', true)
  const [clearShots, setClearShots] = useDesktopSetting('clearPositionShots', false)
  const [cleanAfter, setCleanAfter] = useDesktopSetting('cleanAfterUpdate', true)
  const [searchBar, setSearchBar] = useDesktopSetting('searchBar', false)
  const [autoSwitch, setAutoSwitch] = usePref('autoSwitchGameMode')
  const [autoTick, setAutoTick] = usePref('autoTickFromLogs')
  const scavMinutes = useTimersStore((s) => s.scavCooldownMinutes)
  const setScavMinutes = useTimersStore((s) => s.setScavCooldownMinutes)
  return (
    <Section id="desktop" title="Desktop app" icon={Monitor} desktopOnly keywords="windows start tray minimize close hotkey shortcut search bar overlay update clean cleanup installer leftover delete space disk logs game log watching folder pvp pve switch tick quests where am i position screenshot recycle bin clear delete scav cooldown timer">
      {settingsError && <p role="alert" className="text-sm text-danger">Could not save desktop setting: {settingsError}</p>}
      <Row label="Close to tray" hint="The X button hides the window and keeps quest tracking running. Use the tray icon to reopen or quit.">
        <Switch checked={tray} onChange={setTray} label="Close to tray" />
      </Row>
      <Row label="Start with Windows">
        <Switch checked={startWin} onChange={setStartWin} label="Start with Windows" />
      </Row>
      <Row label="Start minimized to tray">
        <Switch checked={startMin} onChange={setStartMin} label="Start minimized" />
      </Row>
      <StagedUpdateCheck />
      <Row label="Updates" hint="Automatic downloads new versions in the background and asks before restarting. 'Only tell me' shows a Download button instead. Off never checks by itself (About → Check for updates still works).">
        <Segmented value={updates} onChange={setUpdates} label="Updates" options={[{ value: 'auto', label: 'Automatic' }, { value: 'notify', label: 'Only tell me' }, { value: 'off', label: 'Off' }]} />
      </Row>
      <Row label="Clean up after updates" hint="A minute after a new version starts, removes what older versions left behind: downloaded update installers, old map and scanner packs, crash reports and compiled code. Older Tarkov Companion installers in your Downloads folder go to the Recycle Bin. Your progress, settings and backups are never touched.">
        <Switch checked={cleanAfter} onChange={setCleanAfter} label="Clean up after updates" />
      </Row>
      <Row label="Clean up now" hint="Shows what would be removed first; nothing goes until you click Remove.">
        <CleanupPanel />
      </Row>
      <Row label="Stash scanner hotkey" hint="Captures the screen the game is on and opens the scanner with it.">
        <HotkeyRecorder />
      </Row>
      <Row label="Search bar over the game" hint="A small magnifying glass on top of the game (borderless or windowed mode); drag it anywhere. Click it to search maps, items, keys, quests, traders, bosses, extracts and hideout stations; maps show quests, bosses, spawns, locked doors and loot. Its own settings are behind the sliders button in the bar.">
        <Switch checked={searchBar} onChange={setSearchBar} label="Search bar over the game" />
      </Row>
      {searchBar && (
        <>
          <Row label="Show / hide the search bar" hint="Hides it completely (or brings it back) while the game has focus.">
            <HotkeyRecorder setting="searchBarHotkey" />
          </Row>
          <Row label="Open the search box" hint="Shows the bar and puts the cursor in the search box, so you can type at once. This takes the keyboard from the game; press Esc to give it back.">
            <HotkeyRecorder setting="searchBarSearchHotkey" />
          </Row>
          <Row label="Lock the search bar" hint="Locked, every click goes through it to the game (for a map you only look at). Press the hotkey again, or use the tray icon, to unlock.">
            <HotkeyRecorder setting="searchBarLockHotkey" />
          </Row>
          <Row label="Open / close the raid's map" hint="Opens the map of the raid you are in (from the game log), else the last map, without taking the keyboard from the game.">
            <HotkeyRecorder setting="searchBarMapHotkey" />
          </Row>
        </>
      )}
      <Row label="Switch PvP / PvE with the game" hint="Follows the mode you play in, read from the game log.">
        <Switch checked={autoSwitch} onChange={setAutoSwitch} label="Switch game mode" />
      </Row>
      <Row label="Tick quests from the game log" hint="When a trader accepts a hand-in, the quest is ticked here by itself. Off: use 'Read past logs' to review them instead.">
        <Switch checked={autoTick} onChange={setAutoTick} label="Tick quests from the game log" />
      </Row>
      <Row label="'Where am I' from screenshots" hint="Reads your position from the names of new in-game screenshots (press Print Screen in raid). Only file names are read.">
        <Switch checked={track} onChange={setTrack} label="Where am I" />
      </Row>
      {track && (
        <Row label="Clear those screenshots after reading" hint="Moves each screenshot you take during a raid to the Recycle Bin a few seconds after its position is read, so the folder does not fill up (if Windows refuses the Recycle Bin, into a 'Read by Tarkov Companion' folder inside the Screenshots folder instead). Screenshots taken outside a raid (stash shots for the scanner) are kept. Nothing is deleted outright.">
          <Switch checked={clearShots} onChange={setClearShots} label="Clear position screenshots" />
        </Row>
      )}
      <Row label="Scav cooldown" hint="Length of the scav timer on the Dashboard.">
        <div className="flex items-center gap-1.5 text-sm">
          <input type="number" min={1} max={90} value={scavMinutes} onChange={(e) => setScavMinutes(e.target.valueAsNumber)} className="w-16 rounded border border-line bg-surface px-1.5 py-1 text-sm" aria-label="Scav cooldown minutes" /> min
        </div>
      </Row>
      <div className="px-4 py-3">
        <DesktopSettingsSection />
      </div>
      <div className="space-y-4 px-4 py-3">
        <SyncHistorySection />
      </div>
    </Section>
  )
}

function ProgressSection() {
  const startingReputation = usePrefs((p) => p.startingReputation)
  const setPref = usePrefs((p) => p.set)
  const resetProgress = useProgressStore((s) => s.resetProgress)
  const gameMode = useProgressStore((s) => s.gameMode)
  const [autoBackup, setAutoBackup] = usePref('autoBackup')
  const [keep, setKeep] = useDesktopSetting('backupKeep', 7)
  const fileInput = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const modeLabel = gameMode === 'pve' ? 'PvE' : 'PvP'

  const handleExport = () => {
    const date = new Date().toISOString().slice(0, 10)
    const blob = new Blob([JSON.stringify(buildProgressFile(), null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `tarkov-companion-progress-${date}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setMessage({ kind: 'ok', text: 'Progress file downloaded (quests, item collection, keys, hideout, map drawings, story chapters and your raid log).' })
  }

  const handleImport = async (file: File) => {
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('that file is too large to be a progress file')
      const parsed = parseImportJson(await file.text())
      const restored = importProgressFile(parsed)
      setMessage({ kind: 'ok', text: `Imported ${restored.join(', ')} from ${file.name}.` })
    } catch (err) {
      setMessage({ kind: 'error', text: `Import failed: ${err instanceof Error ? err.message : 'invalid file'}` })
    } finally {
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <Section id="progress" title="Progress & backups" icon={ShieldCheck} keywords="progress export import backup restore reset wipe archive save file trader loyalty reputation edition standing level">
      <Row label="Game edition (starting trader reputation)" hint="Trader loyalty levels are worked out from this, the reputation your finished quests gave, and your level. Prepare for Escape, Edge of Darkness and The Unheard start every main trader at +0.2; Standard and Left Behind at 0.">
        <Segmented value={startingReputation === 0.2 ? 'bonus' : 'none'} onChange={(v) => setPref('startingReputation', v === 'bonus' ? 0.2 : 0)} label="Starting trader reputation" options={[{ value: 'none', label: 'Standard / Left Behind' }, { value: 'bonus', label: 'PfE / EoD / Unheard (+0.2)' }]} />
      </Row>
      <Row label="Export or import progress" hint="One file with your quests, items, keys, hideout, drawings, story and raid log. Use it to move to another PC or keep a copy.">
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={handleExport} className="btn">
            <Download className="h-4 w-4" /> Export
          </button>
          <button type="button" onClick={() => fileInput.current?.click()} className="btn">
            <Upload className="h-4 w-4" /> Import
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleImport(file)
            }}
          />
        </div>
      </Row>
      {isDesktop() && (
        <>
          <Row label="Daily backups" hint="Saves your whole progress once a day on this PC.">
            <Switch checked={autoBackup} onChange={setAutoBackup} label="Daily backups" />
          </Row>
          <Row label="Backups to keep" hint="Older ones are deleted.">
            <Select value={keep} onChange={setKeep} label="Backups to keep" options={[3, 7, 14, 30].map((n) => ({ value: n, label: `${n} days` }))} />
          </Row>
          <div className="space-y-4 px-4 py-3">
            <HealthAndBackups />
            <ArchivesSettings />
          </div>
        </>
      )}
      <Row label={`Reset ${modeLabel} progress`} hint="Unticks every quest and clears level and faction for this game mode. Export first if you might want it back.">
        <button
          type="button"
          onClick={() => {
            if (!confirmReset) return setConfirmReset(true)
            resetProgress()
            setConfirmReset(false)
            setMessage({ kind: 'ok', text: `Progress for ${modeLabel} was reset.` })
          }}
          onBlur={() => setConfirmReset(false)}
          className={`btn ${confirmReset ? 'border-danger text-danger' : ''}`}
        >
          <Trash2 className="h-4 w-4" />
          {confirmReset ? 'Click again to confirm' : 'Reset'}
        </button>
      </Row>
      {message && (
        <p role="status" className={`mx-4 my-3 rounded border px-3 py-2 text-xs ${message.kind === 'ok' ? 'border-success/40 bg-success/10 text-success' : 'border-danger/40 bg-danger/10 text-danger'}`}>
          {message.text}
        </p>
      )}
    </Section>
  )
}

function AboutPanel() {
  return (
    <Section id="about" title="About" icon={Info} keywords="about version credits licence license update github safety anticheat">
      <div className="px-4 py-3">
        <AboutSection />
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'prices', label: 'Prices & data', icon: Database },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'maps', label: 'Maps', icon: MapIcon },
  { id: 'scanner', label: 'Stash scanner', icon: ScanSearch },
  { id: 'desktop', label: 'Desktop app', icon: Monitor, desktopOnly: true },
  { id: 'progress', label: 'Progress & backups', icon: ShieldCheck },
  { id: 'about', label: 'About', icon: Info },
]

export function SettingsPage() {
  const [query, setQuery] = useState('')
  const resetAll = usePrefs((s) => s.resetAll)
  const [confirmResetAll, setConfirmResetAll] = useState(false)
  const { hash } = useLocation()
  const sections = useMemo(() => SECTIONS.filter((s) => !s.desktopOnly || isDesktop()), [])

  // Links like /settings#desktop (the sidebar's log status) scroll to that section.
  useEffect(() => {
    const id = hash.replace('#', '')
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'start' })
  }, [hash])

  return (
    <SearchContext.Provider value={query}>
      <div className="space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-xl font-semibold">
              <Gauge className="h-5 w-5 text-accent" /> Settings
            </h1>
            <p className="text-sm text-ink-muted">Changes are saved straight away.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search settings…"
                aria-label="Search settings"
                className="w-56 rounded border border-line bg-surface py-1.5 pl-8 pr-7 text-sm"
              />
              {query && (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-dim hover:text-ink">
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            <button
              type="button"
              className={`btn ${confirmResetAll ? 'border-danger text-danger' : ''}`}
              onBlur={() => setConfirmResetAll(false)}
              onClick={() => {
                if (!confirmResetAll) return setConfirmResetAll(true)
                resetAll()
                setConfirmResetAll(false)
              }}
              title="Puts appearance, general, prices, notifications, map and scanner settings back to their defaults. Your progress is not touched."
            >
              <RotateCcw className="h-4 w-4" /> {confirmResetAll ? 'Click again to reset' : 'Default settings'}
            </button>
          </div>
        </header>

        <div className="flex gap-6">
          <nav className="sticky top-4 hidden h-fit w-48 shrink-0 space-y-0.5 lg:block" aria-label="Settings sections">
            {sections.map((s) => (
              <a key={s.id} href={`#${s.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }} className="flex items-center gap-2 rounded px-2.5 py-1.5 text-sm text-ink-muted hover:bg-surface-3 hover:text-ink">
                <s.icon className="h-4 w-4" aria-hidden /> {s.label}
              </a>
            ))}
          </nav>
          <div className="min-w-0 flex-1 space-y-4">
            <AppearanceSection />
            <GeneralSection />
            <PricesSection />
            <NotificationsSection />
            <MapsSection />
            <ScannerSection />
            <DesktopAppSection />
            <ProgressSection />
            <AboutPanel />
            {query && (
              <p className="text-center text-sm text-ink-dim">
                Not finding it? Try another word, or{' '}
                <button type="button" onClick={() => setQuery('')} className="text-accent underline">
                  show all settings
                </button>
                .
              </p>
            )}
          </div>
        </div>
      </div>
    </SearchContext.Provider>
  )
}

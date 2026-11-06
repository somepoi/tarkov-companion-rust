import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, EyeOff, Keyboard, LayoutGrid, Lock } from 'lucide-react'
import type { DesktopSettings } from '../shared/desktop-api'
import { ActionButton } from './details'
import { LIMITS, useOverlayPrefs, type OverlayPrefs } from './overlayPrefs'

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-2 border-t border-white/10 pt-1.5">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-white/55">{title}</div>
      <div className="space-y-1.5">{children}</div>
    </div>
  )
}

function Slider({ label, k, step = 5, suffix = '%', onPreview }: { label: string; k: keyof typeof LIMITS & keyof OverlayPrefs; step?: number; suffix?: string; onPreview?: (on: boolean) => void }) {
  const value = useOverlayPrefs((s) => s[k]) as number
  const set = useOverlayPrefs((s) => s.set)
  const [lo, hi] = LIMITS[k]
  return (
    <label className="block text-xs">
      <span className="flex justify-between text-white/70">
        {label} <span className="tabular-nums text-white">{value}{suffix}</span>
      </span>
      <input
        type="range"
        min={lo}
        max={hi}
        step={step}
        value={value}
        onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<OverlayPrefs>)}
        // While the slider is held, show the real see-through level (not the full hover look).
        onPointerDown={() => onPreview?.(true)}
        onPointerUp={() => onPreview?.(false)}
        onPointerCancel={() => onPreview?.(false)}
        className="w-full accent-[var(--color-accent)]"
      />
    </label>
  )
}

function Check({ label, k, hint }: { label: string; k: keyof OverlayPrefs; hint?: string }) {
  const value = useOverlayPrefs((s) => s[k]) as boolean
  const set = useOverlayPrefs((s) => s.set)
  return (
    <label className="flex cursor-pointer items-start gap-1.5 text-xs text-white/80" title={hint}>
      <input type="checkbox" checked={value} onChange={(e) => set({ [k]: e.target.checked } as Partial<OverlayPrefs>)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]" />
      <span>
        {label}
        {hint && <span className="block text-[10px] text-white/45">{hint}</span>}
      </span>
    </label>
  )
}

type HotkeyName = 'searchBarHotkey' | 'searchBarSearchHotkey' | 'searchBarLockHotkey' | 'searchBarMapHotkey'

/** Records a global hotkey and saves it in the app's settings (the same ones as Settings → Desktop app). */
function HotkeyField({ name, label, settings, onSaved }: { name: HotkeyName; label: string; settings: DesktopSettings | null; onSaved: (s: DesktopSettings) => void }) {
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') return setRecording(false)
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean) as string[]
      const code = e.code
      const key = /^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d{1,2}$/.test(code) ? code : code === 'Space' ? 'Space' : null
      if (!mods.length || !key) return setError('Use Ctrl, Alt or Shift plus a letter, number or F-key.')
      setError(null)
      setRecording(false)
      void window.desktop?.setSettings({ [name]: [...mods, key].join('+') })
        .then(onSaved)
        // The key was not saved (for example the file is read-only): say so instead of leaving
        // the field showing a shortcut that will not survive a restart.
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, name, onSaved])
  const current = settings?.[name] ?? ''
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 text-white/75">{label}</span>
        <kbd className="rounded border border-white/20 bg-white/5 px-1.5 py-0.5 font-mono text-[11px]">{recording ? 'Press keys…' : current || 'Off'}</kbd>
        <button type="button" onClick={() => setRecording(true)} title="Change" aria-label={`Change: ${label}`} className="rounded border border-white/20 p-1 hover:bg-white/10">
          <Keyboard className="h-3 w-3" />
        </button>
        {current && (
          <button type="button" onClick={() => void window.desktop?.setSettings({ [name]: '' }).then(onSaved).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))} className="text-[10px] text-white/45 hover:text-white">
            off
          </button>
        )}
      </div>
      {error && <p className="text-[10px] text-red-300">{error}</p>}
    </div>
  )
}

const LOOT_STEPS = [10_000, 25_000, 50_000, 100_000, 250_000, 500_000]

export function SettingsView({ onPreview }: { onPreview: (on: boolean) => void }) {
  const p = useOverlayPrefs()
  const [desk, setDesk] = useState<DesktopSettings | null>(null)
  useEffect(() => {
    void window.desktop?.getSettings().then(setDesk)
  }, [])
  const lockKey = desk?.searchBarLockHotkey
  const toggleKey = desk?.searchBarHotkey
  return (
    <>
      <div className="font-medium">Search bar settings</div>
      <p className="text-[11px] text-white/50">Saved on this PC. Always fully visible while the mouse is over it.</p>

      <Group title="Look">
        <Slider label="See-through at rest" k="idle" onPreview={onPreview} />
        <Slider label="With a map or side panels open" k="map" onPreview={onPreview} />
        <Slider label="Size of text and cards (not the map)" k="scale" />
        <Slider label="Size of map markers" k="markerScale" step={10} />
      </Group>

      <Group title="Where it sits">
        <div className="flex flex-wrap gap-1">
          <ActionButton onClick={() => void window.desktop?.searchBarCorner('tl')} title="Top left">
            <ArrowUpLeft className="h-3 w-3" /> Top left
          </ActionButton>
          <ActionButton onClick={() => void window.desktop?.searchBarCorner('tr')} title="Top right">
            <ArrowUpRight className="h-3 w-3" /> Top right
          </ActionButton>
          <ActionButton onClick={() => void window.desktop?.searchBarCorner('bl')} title="Bottom left">
            <ArrowDownLeft className="h-3 w-3" /> Bottom left
          </ActionButton>
          <ActionButton onClick={() => void window.desktop?.searchBarCorner('br')} title="Bottom right">
            <ArrowDownRight className="h-3 w-3" /> Bottom right
          </ActionButton>
        </div>
        <p className="text-[10px] text-white/45">Or drag the magnifying glass (or the grip on the left of the bar) anywhere, on any screen. Cards, the map and side panels each have a move bar on top and a resize corner bottom right.</p>
        <div className="flex flex-wrap gap-1">
          <ActionButton onClick={() => useOverlayPrefs.getState().reset('boxes')} title="Cards, the map and side panels open next to the glass again, at their usual size">
            <LayoutGrid className="h-3 w-3" /> Put boxes back next to the glass
          </ActionButton>
        </div>
        <div className="flex flex-wrap gap-1">
          <ActionButton onClick={() => void window.desktop?.setSearchBarLocked(true)} title="Every click goes through to the game">
            <Lock className="h-3 w-3" /> Lock (clicks go through)
          </ActionButton>
          <ActionButton onClick={() => void window.desktop?.hideSearchBar()} title="Hide it completely">
            <EyeOff className="h-3 w-3" /> Hide it
          </ActionButton>
        </div>
        <p className="text-[10px] text-white/45">
          Unlock with {lockKey || 'the lock hotkey'} or the tray icon; bring it back with {toggleKey || 'the show/hide hotkey'} or the tray icon.
        </p>
      </Group>

      <Group title="Hotkeys (work while the game has focus)">
        <HotkeyField name="searchBarHotkey" label="Show / hide" settings={desk} onSaved={setDesk} />
        <HotkeyField name="searchBarSearchHotkey" label="Open the search box" settings={desk} onSaved={setDesk} />
        <HotkeyField name="searchBarLockHotkey" label="Lock / unlock" settings={desk} onSaved={setDesk} />
        <HotkeyField name="searchBarMapHotkey" label="Open / close the raid's map" settings={desk} onSaved={setDesk} />
        <p className="text-[10px] text-white/45">"Open the search box" takes the keyboard from the game; Esc gives it back.</p>
      </Group>

      <Group title="Sizes">
        <Slider label="Map width" k="mapW" step={10} suffix=" px" />
        <Slider label="Map height" k="mapH" step={10} suffix=" px" />
        <Slider label="List beside the map" k="sideW" step={8} suffix=" px" />
        <Slider label="Side panels" k="panelW" step={10} suffix=" px" />
        <p className="text-[10px] text-white/45">You can also drag the map's bottom corner.</p>
      </Group>

      <Group title="Pills next to the glass">
        <Check label="Time left in the raid" k="stripRaid" hint="From the game log; click it for the raid's map." />
        <Check label="Tarkov time (left · right)" k="stripClock" />
        <Check label="Scav cooldown" k="stripScav" hint="The Dashboard's scav timer." />
        <Check label="Story wait timer" k="stripStory" hint="A wait started on the Story tab (shown while one runs)." />
        <Check label="Next trader restock" k="stripRestock" />
        <Check label="Stash scan button (camera)" k="scanButton" hint="Drag a box over stash slots: keep or sell, and what they are worth." />
      </Group>

      <Group title="In raid">
        <Check label="Open the raid's map when a raid starts" k="autoRaidMap" />
        <Check label="Show where I am from in-game screenshots" k="followPosition" hint="Press Print Screen in raid; only the file name is read." />
        <Check label="Open the last map again when the app starts" k="restoreMap" />
      </Group>

      <Group title="Valuable loot layer">
        <div className="flex flex-wrap gap-1">
          {LOOT_STEPS.map((v) => (
            <button key={v} type="button" onClick={() => p.set({ lootMin: v })} className={`rounded border px-1.5 py-0.5 text-[11px] ${p.lootMin === v ? 'border-amber-300/60 bg-amber-300/15 text-amber-100' : 'border-white/20 hover:bg-white/10'}`}>
              {v >= 1000 ? `${v / 1000}k` : v} ₽
            </button>
          ))}
        </div>
        <Check label="Count per inventory slot" k="lootPerSlot" hint="A 1×1 item worth 50k beats a 2×2 worth 100k." />
      </Group>

      <Group title="Start over">
        <div className="flex flex-wrap gap-1">
          <ActionButton onClick={() => p.set({ recent: [] })}>Forget recent searches</ActionButton>
          <ActionButton onClick={() => p.reset('look')}>Default look</ActionButton>
          <ActionButton onClick={() => p.reset('size')}>Default sizes</ActionButton>
          <ActionButton onClick={() => p.reset('all')}>Everything</ActionButton>
        </div>
      </Group>
    </>
  )
}

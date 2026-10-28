import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Lock, Search } from 'lucide-react'
import type { GameEvent } from '../shared/desktop-api'
import { raidMap, raidOverAt, reduceRaid, type MapRow, type RaidState, type RestockRow } from './overlayLogic'
import { useOverlayPrefs } from './overlayPrefs'
import { Pills } from './pills'
import { columnClass, useDrag, type Flip } from './shell'
import { useNativeRegions } from './useNativeRegions'

// Everything past the magnifying glass (game data, search, cards, maps) loads on the first click.
const SearchBarBody = lazy(() => import('./SearchBarBody'))

/** Nothing open for this long: the game data is dropped from memory (it loads again on the next click). */
const IDLE_UNLOAD_MS = 3 * 60_000
/** Map names and raid lengths, kept by the body so the raid pill can name the map before the data loads. */
export const MAP_ROWS_KEY = 'tc-overlay-maps'
/** Sent in this window when the body saves the table. */
export const MAP_ROWS_EVENT = 'tc-overlay-maps'

function readRows(): MapRow[] {
  try {
    const v = JSON.parse(localStorage.getItem(MAP_ROWS_KEY) ?? '[]') as MapRow[]
    return Array.isArray(v) ? v.filter((r) => r && typeof r.nameId === 'string' && typeof r.name === 'string') : []
  } catch {
    return []
  }
}

/** Trader restock times, kept by the body (for the restock pill). */
export const RESTOCKS_KEY = 'tc-overlay-restocks'

function readRestocks(): RestockRow[] {
  try {
    const v = JSON.parse(localStorage.getItem(RESTOCKS_KEY) ?? '[]') as RestockRow[]
    return Array.isArray(v) ? v.filter((r) => r && typeof r.name === 'string' && typeof r.at === 'number') : []
  } catch {
    return []
  }
}

/** Story wait timers from the Story tab, for the game mode you are in. */
function readStory(): { byMode: unknown; mode: string } {
  try {
    const story = JSON.parse(localStorage.getItem('tarkov-companion-story') ?? 'null') as { state?: { byMode?: unknown } } | null
    const progress = JSON.parse(localStorage.getItem('tarkov-companion-progress') ?? 'null') as { state?: { gameMode?: unknown } } | null
    return { byMode: story?.state?.byMode ?? null, mode: progress?.state?.gameMode === 'regular' ? 'regular' : 'pve' }
  } catch {
    return { byMode: null, mode: 'pve' }
  }
}

/** Scav cooldown end from the app's timers (set on the Dashboard). */
function readScavEnd(): number | null {
  try {
    const v = JSON.parse(localStorage.getItem('tarkov-companion-timers') ?? 'null') as { state?: { scavCooldownEndsAt?: unknown } } | null
    const end = v?.state?.scavCooldownEndsAt
    return typeof end === 'number' ? end : null
  } catch {
    return null
  }
}

function wantsRestore(): boolean {
  const s = useOverlayPrefs.getState()
  return s.restoreMap && Boolean(s.lastMapKey)
}

/** What the body is asked to do from outside (the raid pill, a new raid, the search hotkey). */
export type Request = { nonce: number; kind: 'raidMap' | 'focus' | 'restore' | 'mapToggle' }

/**
 * Desktop: the search bar over the game (its own small window). At rest it is only a magnifying
 * glass (and a few optional pills: the raid's time left, Tarkov time, scav cooldown): click it to
 * search, drag it anywhere. Cards, a map and side panels open around it; the see-through parts let
 * clicks through to the game. It reads the game data the app already saved on this PC.
 */
export function SearchBarApp() {
  const [flip, setFlip] = useState<Flip>({ left: false, up: false })
  // With "open the last map again" on, the bar starts with it.
  const [woken, setWoken] = useState(() => wantsRestore())
  const [expanded, setExpanded] = useState(false)
  const [locked, setLocked] = useState(false)
  const [state, setState] = useState({ busy: false, clear: false, preview: false })
  const [raid, setRaid] = useState<RaidState | null>(null)
  const [rows, setRows] = useState<MapRow[]>(readRows)
  const [scavEnd, setScavEnd] = useState<number | null>(readScavEnd)
  const [restocks, setRestocks] = useState<RestockRow[]>(readRestocks)
  const [story, setStory] = useState(readStory)
  const [request, setRequest] = useState<Request | null>(() => (wantsRestore() ? { nonce: 1, kind: 'restore' } : null))
  const p = useOverlayPrefs()
  const box = useRef<HTMLDivElement>(null)
  const [nativeError, setNativeError] = useState('')
  const reportNativeError = useCallback((message: string) => {
    setNativeError(message)
    void window.desktop?.reportSearchBarError?.(message).catch(() => undefined)
  }, [])
  useNativeRegions(box, reportNativeError)
  const through = useRef<boolean | null>(null)

  useEffect(() => {
    // The page itself is see-through; only the bar is drawn. The window follows its size, so no scroll bars.
    for (const el of [document.documentElement, document.body]) {
      el.style.background = 'transparent'
      el.style.overflow = 'hidden'
    }
    const api = window.desktop
    const offs = [
      api?.onSearchBarLayout(setFlip),
      api?.onSearchBarLocked((on) => {
        setLocked(on)
        through.current = null
      }),
      api?.onSearchBarMap(() => {
        setWoken(true)
        setRequest({ nonce: Date.now(), kind: 'mapToggle' })
      }),
      api?.onSearchBarFocus(() => {
        setWoken(true)
        setExpanded(true)
        setRequest({ nonce: Date.now(), kind: 'focus' })
      }),
    ]
    void api?.isSearchBarLocked().then(setLocked)
    // Clicking back into the game shrinks it to the glass (an open map and side panels stay).
    const blur = () => setExpanded(false)
    window.addEventListener('blur', blur)
    // Clicks on see-through parts go to the game: only drawn parts (data-solid) take the mouse.
    const move = (e: MouseEvent) => {
      const on = !(e.target instanceof Element && e.target.closest('[data-solid]'))
      if (on === through.current) return
      through.current = on
      void api?.setSearchBarPassthrough(on)
    }
    if (!api?.setSearchBarRegions) window.addEventListener('mousemove', move)
    // The app window keeps the scav timer and the map table; follow their changes.
    const storage = (e: StorageEvent) => {
      if (e.key === 'tarkov-companion-timers') setScavEnd(readScavEnd())
      if (e.key === 'tarkov-companion-story' || e.key === 'tarkov-companion-progress') setStory(readStory())
      if (e.key === MAP_ROWS_KEY) setRows(readRows())
      if (e.key === 'tc-overlay-prefs') void useOverlayPrefs.persist.rehydrate()
    }
    window.addEventListener('storage', storage)
    const rowsChanged = () => {
      setRows(readRows())
      setRestocks(readRestocks())
    }
    window.addEventListener(MAP_ROWS_EVENT, rowsChanged)
    void api?.searchBarReady?.().catch(reportNativeError)
    return () => {
      window.removeEventListener(MAP_ROWS_EVENT, rowsChanged)
      offs.forEach((off) => off?.())
      window.removeEventListener('blur', blur)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('storage', storage)
    }
  }, [reportNativeError])

  // The raid you are in, from the game log: what happened recently, then live events.
  const autoRaidMap = p.autoRaidMap
  const raidRef = useRef<RaidState | null>(null)
  useEffect(() => {
    const api = window.desktop
    if (!api) return
    void api.getRecentEvents().then((events) => {
      raidRef.current = reduceRaid([...events].sort((a, b) => a.at - b.at), Date.now())
      setRaid(raidRef.current)
    })
    return api.onEvent((e: GameEvent) => {
      if (e.historical) return
      const before = raidRef.current
      const current = reduceRaid([e], Date.now(), before)
      raidRef.current = current
      setRaid(current)
      // A new raid: open its map when asked to.
      if (current && (!before || before.since !== current.since) && autoRaidMap) {
        setWoken(true)
        setRequest({ nonce: Date.now(), kind: 'raidMap' })
      }
    })
  }, [autoRaidMap])

  // The log often has no end line for a raid: call it over by the clock (10 min after its time ran out).
  const row = useMemo(() => raidMap(raid, rows), [raid, rows])
  useEffect(() => {
    if (!raid) return
    const t = window.setTimeout(() => {
      raidRef.current = null
      setRaid(null)
    }, Math.max(0, raidOverAt(raid, row) - Date.now()))
    return () => window.clearTimeout(t)
  }, [raid, row])

  // Map marker size (the same CSS knob the app's Settings use).
  const markerScale = p.markerScale
  useEffect(() => {
    document.documentElement.style.setProperty('--tc-marker-scale', String(markerScale / 100))
  }, [markerScale])

  // The window follows what is drawn (the glass, the bar, cards, the map, side panels).
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (window.desktop?.setSearchBarRegions) return
    const send = () => {
      const r = el.getBoundingClientRect()
      void window.desktop?.setSearchBarSize(Math.ceil(r.width) + 8, Math.ceil(r.height) + 8)
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Lightweight while it waits: after a while with nothing open, unload the data.
  useEffect(() => {
    if (!woken || expanded || state.busy) return
    const t = window.setTimeout(() => {
      setWoken(false)
      setRequest(null)
    }, IDLE_UNLOAD_MS)
    return () => window.clearTimeout(t)
  }, [woken, expanded, state.busy])

  const open = useCallback(() => {
    setWoken(true)
    setExpanded(true)
  }, [])
  const drag = useDrag(open)
  const grip = useDrag()
  const onState = useCallback(
    (busy: boolean, clear: boolean, preview: boolean) => setState((s) => (s.busy === busy && s.clear === clear && s.preview === preview ? s : { busy, clear, preview })),
    [],
  )

  // Info pills next to the glass (they keep their own clock).
  const zoom = p.scale / 100
  const onRaidClick = useCallback(() => {
    setWoken(true)
    setRequest({ nonce: Date.now(), kind: 'raidMap' })
  }, [])
  const strip = <Pills raid={raid} row={row} scavEnd={scavEnd} story={story} restocks={restocks} zoom={zoom} onRaidClick={onRaidClick} />

  const glass = (
    <div className={`flex items-center gap-1 ${flip.left ? 'flex-row-reverse' : ''}`}>
      <button
        type="button"
        data-solid
        {...drag}
        title={locked ? 'Locked: clicks go through to the game (unlock with the hotkey or the tray icon)' : 'Click to search · drag to move it'}
        aria-label="Open the search"
        className="sb-z relative flex h-10 w-10 shrink-0 cursor-grab touch-none items-center justify-center rounded-full border border-white/15 bg-black/75 text-white/80 shadow-2xl hover:text-white active:cursor-grabbing"
        style={{ zoom }}
      >
        <Search className="h-5 w-5" />
        {locked && <Lock className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-black p-0.5 text-amber-300" />}
      </button>
      {strip}
    </div>
  )
  const fade = (state.clear ? p.map : p.idle) / 100
  const hover = state.preview || locked ? '' : 'hover:opacity-100 focus-within:opacity-100'

  return (
    <div className="fixed inset-0 flex p-1" style={{ justifyContent: flip.left ? 'flex-end' : 'flex-start', alignItems: flip.up ? 'flex-end' : 'flex-start' }}>
      <div
        ref={box}
        className={`flex w-max gap-1.5 text-[13px] text-white transition-opacity duration-150 opacity-(--sb-fade) ${hover} ${flip.left ? 'flex-row-reverse' : ''} ${flip.up ? 'items-end' : 'items-start'}`}
        style={{ fontFamily: 'system-ui, sans-serif', '--sb-fade': fade } as CSSProperties}
      >
        {woken ? (
          <BodyGuard glass={glass} column={columnClass(flip)} onReset={() => setRequest(null)}>
            <Suspense fallback={<div className={columnClass(flip)}>{glass}</div>}>
              <SearchBarBody flip={flip} expanded={expanded} setExpanded={setExpanded} glass={glass} strip={strip} grip={grip} onState={onState} raid={raid} raidRow={row} request={request} locked={locked} />
            </Suspense>
          </BodyGuard>
        ) : (
          <div className={columnClass(flip)}>{glass}</div>
        )}
        {nativeError && <button data-solid type="button" className="max-w-xs rounded border border-red-400/40 bg-black/85 p-2 text-xs text-red-200" onClick={() => setNativeError('')}>Searchbar: {nativeError} · Dismiss</button>}
      </div>
    </div>
  )
}

/**
 * If something inside the bar breaks (unexpected data), the glass keeps working: a small notice
 * offers to start the bar again instead of leaving an empty window over the game.
 */
class BodyGuard extends Component<{ glass: ReactNode; column: string; onReset: () => void; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('[search bar]', error)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className={this.props.column}>
        {this.props.glass}
        <button
          type="button"
          data-solid
          onClick={() => {
            this.props.onReset()
            this.setState({ error: null })
          }}
          className="rounded-lg border border-red-400/40 bg-black/85 px-3 py-1.5 text-xs text-red-200 shadow-xl hover:text-white"
        >
          The search bar hit a problem. Click to start it again.
        </button>
      </div>
    )
  }
}

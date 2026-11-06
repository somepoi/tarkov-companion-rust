import { Component, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Camera, Lock, Search } from 'lucide-react'
import { savedFontStack } from '../lib/fonts'
import type { GameEvent, SearchBarFrame } from '../shared/desktop-api'
import { anchorStyle, GLASS, openSide, shapeRects, type Point } from './boxes'
import { FrameContext, type FrameInfo } from './frameContext'
import { raidMap, raidOverAt, reduceRaid, type MapRow, type RaidState, type RestockRow } from './overlayLogic'
import { useOverlayPrefs } from './overlayPrefs'
import { Pills } from './pills'
import { columnClass, useDrag, useDragging } from './shell'
import { SnipLayer, type SnipBox } from './SnipLayer'
import { cropSnip, useStashScan } from './stashScan'

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
 * Desktop: the search bar over the game. At rest it is only a magnifying glass (and a few optional
 * pills: the raid's time left, Tarkov time, scav cooldown): click it to search, drag it anywhere.
 * Cards, a map and side panels open next to it, and each can be moved and resized on its own. The
 * window covers the screen but is cut to what is drawn, so every other click goes to the game. It
 * reads the game data the app already saved on this PC.
 */
export function SearchBarApp() {
  // The window and the glass (screen pixels), from the main process.
  const [placed, setPlaced] = useState<SearchBarFrame | null>(null)
  // The glass while it is dragged (until the main process has the new spot).
  const [moving, setMoving] = useState<Point | null>(null)
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
  // The app's font choice (Settings → Appearance).
  const [font, setFont] = useState(savedFontStack)
  const [request, setRequest] = useState<Request | null>(() => (wantsRestore() ? { nonce: 1, kind: 'restore' } : null))
  const p = useOverlayPrefs()
  const box = useRef<HTMLDivElement>(null)
  const [nativeError, setNativeError] = useState('')
  const reportNativeError = useCallback((error: unknown) => {
    const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
    setNativeError(message)
    void window.desktop?.reportSearchBarError?.(message).catch(() => undefined)
  }, [])
  // A snip for a stash scan: the screen picture while a box is dragged over it.
  const [snip, setSnip] = useState<{ blob: Blob; url: string } | null>(null)
  const snipSequence = useRef({ value: 0 })
  const snipPending = useRef(false)
  useEffect(() => () => { if (snip) URL.revokeObjectURL(snip.url) }, [snip])

  useEffect(() => {
    // The page itself is see-through; only the bar is drawn. The window follows its size, so no scroll bars.
    for (const el of [document.documentElement, document.body]) {
      el.style.background = 'transparent'
      el.style.overflow = 'hidden'
    }
    const api = window.desktop
    const sequence = snipSequence.current
    void api?.getSearchBarFrame().then((f) => f && setPlaced(f)).catch(reportNativeError)
    const offs = [
      api?.onSearchBarFrame((f) => {
        setPlaced(f)
        setMoving(null)
      }),
      api?.onSearchBarLocked(setLocked),
      api?.onSearchBarMap(() => {
        setWoken(true)
        setRequest({ nonce: Date.now(), kind: 'mapToggle' })
      }),
      api?.onSearchBarFocus(() => {
        setWoken(true)
        setExpanded(true)
        setRequest({ nonce: Date.now(), kind: 'focus' })
      }),
      // Stopped from outside (another window clicked, or it took too long).
      api?.onSnipCancel(() => {
        sequence.value++
        setSnip(null)
      }),
    ]
    void api?.isSearchBarLocked().then(setLocked).catch(reportNativeError)
    void api?.searchBarReady?.().catch(reportNativeError)
    // Clicking back into the game shrinks it to the glass (an open map and side panels stay).
    const blur = () => setExpanded(false)
    window.addEventListener('blur', blur)
    // The app window keeps the scav timer and the map table; follow their changes.
    const storage = (e: StorageEvent) => {
      if (e.key === 'tarkov-companion-timers') setScavEnd(readScavEnd())
      if (e.key === 'tarkov-companion-story' || e.key === 'tarkov-companion-progress') setStory(readStory())
      if (e.key === MAP_ROWS_KEY) setRows(readRows())
      if (e.key === 'tc-overlay-prefs') void useOverlayPrefs.persist.rehydrate()
      if (e.key === 'tarkov-companion-prefs') setFont(savedFontStack())
    }
    window.addEventListener('storage', storage)
    const rowsChanged = () => {
      setRows(readRows())
      setRestocks(readRestocks())
    }
    window.addEventListener(MAP_ROWS_EVENT, rowsChanged)
    return () => {
      sequence.value++
      window.removeEventListener(MAP_ROWS_EVENT, rowsChanged)
      offs.forEach((off) => off?.())
      window.removeEventListener('blur', blur)
      window.removeEventListener('storage', storage)
    }
  }, [reportNativeError, snipSequence])

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

  // Only what is drawn takes the mouse: the window's shape follows the drawn parts (data-solid).
  // While something is dragged or resized, or a snip is on, the whole window takes it.
  const dragging = useDragging((s) => s.count > 0)
  const whole = dragging || Boolean(snip)
  useLayoutEffect(() => {
    const root = box.current
    const api = window.desktop
    if (!root || !api || !placed) return
    let last = ''
    let raf = 0
    let timer = 0
    const send = () => {
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      raf = 0
      timer = 0
      const w = window.innerWidth
      const h = window.innerHeight
      const parts = whole
        ? [{ x: 0, y: 0, width: w, height: h }]
        : [...root.querySelectorAll('[data-solid]')].filter((el) => !el.parentElement?.closest('[data-solid]')).map((el) => el.getBoundingClientRect())
      const rects = shapeRects(parts, w, h)
      const key = JSON.stringify(rects)
      if (!rects.length || key === last) return
      last = key
      void api.setSearchBarShape(rects).catch(reportNativeError)
    }
    // Once per frame at most (and a timer too: frames stop while the window is hidden).
    const schedule = () => {
      if (raf || timer) return
      raf = requestAnimationFrame(send)
      timer = window.setTimeout(send, 80)
    }
    const ro = new ResizeObserver(schedule)
    const watch = () => {
      ro.disconnect()
      ro.observe(root)
      root.querySelectorAll('[data-solid]').forEach((el) => ro.observe(el))
    }
    const mo = new MutationObserver(() => {
      watch()
      schedule()
    })
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] })
    watch()
    send()
    window.addEventListener('resize', schedule)
    return () => {
      mo.disconnect()
      ro.disconnect()
      cancelAnimationFrame(raf)
      window.clearTimeout(timer)
      window.removeEventListener('resize', schedule)
    }
  }, [placed, whole, reportNativeError])

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

  // Camera button: a picture of the screen without the bar, then drag a box over it.
  const startSnip = useCallback(async () => {
    if (snipPending.current) return
    const sequence = ++snipSequence.current.value
    snipPending.current = true
    try {
      const r = await window.desktop?.startSnip()
      if (!r || sequence !== snipSequence.current.value) return
      const blob = new Blob([r.png as BlobPart], { type: 'image/png' })
      setSnip({ blob, url: URL.createObjectURL(blob) })
    } catch (error) {
      reportNativeError(error)
    } finally {
      snipPending.current = false
    }
  }, [reportNativeError, snipSequence])
  const endSnip = useCallback(
    (box: SnipBox | null) => {
      const s = snip
      setSnip(null)
      void window.desktop?.endSnip().catch(reportNativeError)
      const sequence = ++snipSequence.current.value
      if (!s || !box) return
      // The body scans it and opens the Item scan and Values panels.
      void cropSnip(s.blob, box).then((img) => {
        if (sequence !== snipSequence.current.value) return
        useStashScan.getState().start(img, box.w, box.h)
        setWoken(true)
      }).catch(reportNativeError)
    },
    [snip, reportNativeError, snipSequence],
  )
  // Dragging the glass (or the bar's grip): the page moves it; the main process keeps the spot.
  const frame = placed?.frame ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }
  const anchor = moving ?? placed?.anchor ?? { x: frame.x + 16, y: frame.y + 16 }
  const from = useRef<Point>(anchor)
  const to = useRef<Point | null>(null)
  const glassDrag = {
    onStart: () => {
      from.current = anchor
    },
    onMove: (dx: number, dy: number) => {
      to.current = { x: from.current.x + dx, y: from.current.y + dy }
      setMoving(to.current)
    },
    onEnd: () => {
      if (to.current) void window.desktop?.searchBarMoved(to.current.x, to.current.y).catch((error) => {
        setMoving(null)
        reportNativeError(error)
      })
      to.current = null
    },
  }
  const drag = useDrag({ ...glassDrag, onClick: open })
  const grip = useDrag(glassDrag)
  // On screen while it is dragged towards another screen (it moves there when let go).
  const shown = {
    x: Math.min(Math.max(anchor.x, frame.x), frame.x + frame.width - GLASS),
    y: Math.min(Math.max(anchor.y, frame.y), frame.y + frame.height - GLASS),
  }
  const flip = openSide(shown, frame)
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
      {p.scanButton && !locked && (
        <button
          type="button"
          data-solid
          onClick={() => void startSnip()}
          title="Check stash slots: drag a box to review detections and catalog values"
          aria-label="Scan stash slots"
          className="sb-z flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/15 bg-black/75 text-white/75 shadow-2xl hover:text-white"
          style={{ zoom }}
        >
          <Camera className="h-4 w-4" />
        </button>
      )}
      {strip}
    </div>
  )
  const fade = snip ? 1 : (state.clear ? p.map : p.idle) / 100
  const hover = state.preview || locked ? '' : 'hover:opacity-100 focus-within:opacity-100'
  const info = useMemo<FrameInfo>(() => ({ frame, anchor: shown, flip, zoom }), [frame.x, frame.y, frame.width, frame.height, shown.x, shown.y, flip.left, flip.up, zoom]) // eslint-disable-line react-hooks/exhaustive-deps
  const atGlass = <div className={`absolute ${columnClass(flip)}`} style={anchorStyle(shown, frame, flip)}>{glass}</div>

  return (
    <div
      ref={box}
      className={`fixed inset-0 text-[13px] text-white transition-opacity duration-150 opacity-(--sb-fade) ${hover}`}
      style={{ fontFamily: font, '--sb-fade': fade } as CSSProperties}
    >
      {snip && <SnipLayer url={snip.url} onDone={endSnip} onCancel={() => endSnip(null)} />}
      {nativeError && <button data-solid type="button" className="absolute left-4 top-16 z-50 max-w-xs rounded border border-red-400/40 bg-black/85 p-2 text-xs text-red-200" onClick={() => setNativeError('')}>Search bar: {nativeError} · Dismiss</button>}
      {placed && (
        <FrameContext.Provider value={info}>
          {woken ? (
            <BodyGuard glass={atGlass} onReset={() => setRequest(null)}>
              <Suspense fallback={atGlass}>
                <SearchBarBody expanded={expanded} setExpanded={setExpanded} glass={glass} strip={strip} grip={grip} onState={onState} raid={raid} raidRow={row} request={request} locked={locked} />
              </Suspense>
            </BodyGuard>
          ) : (
            atGlass
          )}
        </FrameContext.Provider>
      )}
    </div>
  )
}

/**
 * If something inside the bar breaks (unexpected data), the glass keeps working: a small notice
 * offers to start the bar again instead of leaving an empty window over the game.
 */
class BodyGuard extends Component<{ glass: ReactNode; onReset: () => void; children: ReactNode }, { error: Error | null }> {
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
      <>
        {this.props.glass}
        <button
          type="button"
          data-solid
          onClick={() => {
            this.props.onReset()
            this.setState({ error: null })
          }}
          className="absolute left-1/2 top-4 -translate-x-1/2 rounded-lg border border-red-400/40 bg-black/85 px-3 py-1.5 text-xs text-red-200 shadow-xl hover:text-white"
        >
          The search bar hit a problem. Click to start it again.
        </button>
      </>
    )
  }
}

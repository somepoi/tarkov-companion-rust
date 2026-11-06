import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import { Hourglass, Maximize2, Minus, Move, Plus, RotateCcw, Sparkles, Tag, Zap } from 'lucide-react'
import type { GameMode } from '../api/client'
import type { HideoutStation, Item, Trader } from '../api/types'
import { hideoutSummary, type StationInfo } from '../lib/hideoutState'
import { useNow } from '../searchbar/shell'
import { useHideoutSpots } from '../store/hideoutSpots'
import { useHideoutTimers } from '../store/hideoutTimers'
import { Countdown } from './Countdown'
import { HideoutPlan } from './HideoutPlan'
import { activeTimer, lookLabel, lookOf, type Look, type Names } from './look'
import { darkness, WALL_STATION } from './plan'
import './bunker.css'
import { StationPanel } from './StationPanel'
import { useStationSpots } from './useStationSpots'

const MAX_ZOOM = 2.5

const COUNTERS: { look: Look; label: string }[] = [
  { look: 'ready', label: 'meet tracked requirements' },
  { look: 'building', label: 'building' },
  { look: 'done', label: 'finished?' },
  { look: 'items', label: 'need items' },
  { look: 'review', label: 'need a check' },
  { look: 'locked', label: 'locked' },
  { look: 'max', label: 'fully built' },
]

/** On/off switches remembered in this browser only (Live animations, station names on the plan). */
function useFlag(key: string, fallback: boolean): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      const v = localStorage.getItem(key)
      return v === null ? fallback : v === 'on'
    } catch {
      return fallback
    }
  })
  const toggle = () =>
    setOn((v) => {
      try {
        localStorage.setItem(key, v ? 'off' : 'on')
      } catch {
        /* private window: only this visit */
      }
      return !v
    })
  return [on, toggle]
}

export interface BunkerProps {
  stations: HideoutStation[]
  infos: Map<string, StationInfo>
  gameMode: GameMode
  items: Record<string, Item> | undefined
  traders: Trader[]
  /** Your loyalty per trader (null while the quest data loads). */
  traderLevel: Record<string, number> | null
  collected: Record<string, number>
  setLevel: (stationId: string, level: number) => void
  setCollected: (itemId: string, count: number) => void
}

export function BunkerView(props: BunkerProps) {
  const { stations, infos, gameMode, traders } = props
  const panelRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<Look | null>(null)
  const [arrange, setArrange] = useState(false)
  const [motion, toggleMotion] = useFlag('tc-hideout-motion', true)
  const [showNames, toggleNames] = useFlag('tc-hideout-names', false)
  // Zoom: 1 = the whole bunker fits; above that the map scrolls and can be dragged around.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(1)
  const keepCentre = useRef<{ cx: number; cy: number } | null>(null)
  const panning = useRef<{ x: number; y: number; left: number; top: number } | null>(null)
  const zoomTo = (next: number) => {
    const el = scrollRef.current
    if (el) keepCentre.current = { cx: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth, cy: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight }
    setZoom(Math.min(MAX_ZOOM, Math.max(1, Math.round(next * 100) / 100)))
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    const c = keepCentre.current
    if (!el || !c) return
    el.scrollLeft = c.cx * el.scrollWidth - el.clientWidth / 2
    el.scrollTop = c.cy * el.scrollHeight - el.clientHeight / 2
    keepCentre.current = null
  }, [zoom])
  const panStart = (e: PointerEvent<HTMLDivElement>) => {
    const el = scrollRef.current
    if (!el || zoom <= 1 || e.button !== 0 || (e.target as HTMLElement).closest('.tc-hex')) return
    panning.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop }
    try {
      el.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone */
    }
  }
  const panMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = panning.current
    const el = scrollRef.current
    if (!p || !el) return
    el.scrollLeft = p.left - (e.clientX - p.x)
    el.scrollTop = p.top - (e.clientY - p.y)
  }
  const timers = useHideoutTimers((s) => s.byMode[gameMode])
  const spots = useStationSpots(stations)
  const resetSpots = useHideoutSpots((s) => s.reset)
  const moved = useHideoutSpots((s) => Object.keys(s.spots).length)
  // Markers flip from "building" to "finished?" on this clock; the countdown text ticks by itself.
  const now = useNow(Object.keys(timers).length > 0 ? 15_000 : null)

  const looks = useMemo(() => {
    const out = new Map<string, Look>()
    for (const [id, info] of infos) out.set(id, lookOf(info, timers[id], now))
    return out
  }, [infos, timers, now])
  const summary = useMemo(() => hideoutSummary(infos.values()), [infos])
  const counts = useMemo(() => {
    const c: Partial<Record<Look, number>> = {}
    for (const l of looks.values()) c[l] = (c[l] ?? 0) + 1
    return c
  }, [looks])
  const byName = useMemo(() => new Map([...infos.values()].map((i) => [i.station.normalizedName, i])), [infos])
  const names = useMemo<Names>(
    () => ({
      station: (id: string) => infos.get(id)?.station.name ?? 'Station',
      trader: (id: string) => traders.find((t) => t.id === id)?.name ?? 'Trader',
    }),
    [infos, traders],
  )
  const light = byName.get('illumination')
  const generator = byName.get('generator')
  const wall = byName.get(WALL_STATION)
  const wallOpen = !wall || wall.level >= wall.max

  // Hovering a station fades everything it has nothing to do with.
  const related = useMemo(() => {
    const info = hover ? infos.get(hover) : undefined
    if (!info) return null
    const ids = new Set([info.station.id])
    for (const r of info.next?.stationLevelRequirements ?? []) ids.add(r.stationId)
    for (const u of info.unlocks) ids.add(u.stationId)
    return ids
  }, [hover, infos])
  const shown = (id: string) => (!related || related.has(id)) && (highlight === null || looks.get(id) === highlight)

  const pick = (id: string | null) => {
    setSelected((cur) => (cur === id ? null : id))
    if (id && zoom > 1) requestAnimationFrame(() => scrollRef.current?.querySelector(`[data-station="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' }))
    if (id && !window.matchMedia('(min-width: 1280px)').matches) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  useEffect(() => {
    if (!selected && !arrange) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSelected(null)
      setArrange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, arrange])

  const ready = [...infos.values()].filter((i) => looks.get(i.station.id) === 'ready')
  const building = [...infos.values()].flatMap((i) => {
    const t = activeTimer(i, timers[i.station.id])
    return t ? [{ info: i, timer: t }] : []
  })
  const pct = summary.total ? Math.round((summary.built / summary.total) * 100) : 0
  const selectedInfo = selected ? infos.get(selected) ?? null : null
  const sorted = useMemo(() => [...stations].sort((a, b) => a.name.localeCompare(b.name)), [stations])

  return (
    <div className={`mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_21rem] ${motion ? '' : 'tc-still'}`}>
      <div className="min-w-0 space-y-3">
        {/* Overview strip: levels built, states (click to highlight), what can be built now. */}
        <div className="tc-hud">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
            <div className="min-w-[13rem] flex-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="font-semibold uppercase tracking-wider text-ink-muted">Hideout built</span>
                <span className="tabular-nums text-ink-muted">
                  <b className="text-base text-ink">{summary.built}</b>/{summary.total} levels · {pct}%
                </span>
              </div>
              <div className="tc-meter mt-1.5" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Hideout levels built">
                <span style={{ width: `${pct}%` }} />
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Highlight stations">
              {COUNTERS.filter((c) => counts[c.look] || c.look === 'ready').map((c) => (
                <button
                  key={c.look}
                  type="button"
                  aria-pressed={highlight === c.look}
                  onClick={() => setHighlight((h) => (h === c.look ? null : c.look))}
                  className={`tc-counter tc-st-${c.look} ${highlight === c.look ? 'is-on' : ''}`}
                  title={highlight === c.look ? 'Show every station' : `Highlight stations that are ${c.label}`}
                >
                  <b>{counts[c.look] ?? 0}</b> {c.label}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5 text-xs">
            <button type="button" onClick={toggleMotion} aria-pressed={motion} className={`tc-counter ${motion ? 'is-on tc-st-max' : ''}`} title="Moving fans, lights and machines">
              <Sparkles className="h-3.5 w-3.5" /> {motion ? 'Live' : 'Still'}
            </button>
            <button type="button" onClick={toggleNames} aria-pressed={showNames} className={`tc-counter ${showNames ? 'is-on tc-st-max' : ''}`} title="Station names on the map">
              <Tag className="h-3.5 w-3.5" /> Names
            </button>
            <button type="button" onClick={() => setArrange((a) => !a)} aria-pressed={arrange} className={`tc-counter ${arrange ? 'is-on tc-st-items' : ''}`} title="Drag stations to where they are in your hideout">
              <Move className="h-3.5 w-3.5" /> {arrange ? 'Done moving' : 'Move stations'}
            </button>
            {building.map(({ info, timer }) => (
              <button key={info.station.id} type="button" onClick={() => pick(info.station.id)} className="tc-mini tc-st-building">
                <Hourglass className="h-3 w-3" /> {info.station.name} {timer.level} · <Countdown endsAt={timer.endsAt} />
              </button>
            ))}
            {ready.length > 0 && <span className="ml-1 text-ink-muted">Tracked requirements met:</span>}
            {ready.map((i) => (
              <button key={i.station.id} type="button" onClick={() => pick(i.station.id)} className="tc-mini tc-st-ready">
                {i.station.name} {i.next?.level}
              </button>
            ))}
          </div>
        </div>

        {arrange && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-info/50 bg-info/10 px-3 py-2 text-xs text-ink">
            <Move className="h-4 w-4 text-info" />
            <span className="flex-1">
              Drag any station to where it is in your hideout; it is remembered on this computer. Stations with a <b>?</b> were not built in the screenshots this map was drawn from, so their spot is a best guess.
            </span>
            {moved > 0 && (
              <button type="button" onClick={resetSpots} className="btn !px-2 !py-1 !text-xs">
                <RotateCcw className="h-3.5 w-3.5" /> Put all back
              </button>
            )}
            <button type="button" onClick={() => setArrange(false)} className="btn !px-2 !py-1 !text-xs">
              Done
            </button>
          </div>
        )}

        {/* The bunker, seen from above like the game's hideout overview. */}
        <div className="tc-plan-frame">
          <div className="tc-plan-head">
            <span className="tc-plan-title">Hideout</span>
            <span className="flex items-center gap-1">
              <Zap className={`h-3 w-3 ${generator && generator.level > 0 ? 'text-[#f2b84b]' : ''}`} />
              {generator && generator.level > 0 ? `Generator ${generator.level}` : 'No generator'}
            </span>
            <span>{light && light.level > 0 ? `Lights ${light.level}` : 'Lights off'}</span>
            <div className="tc-plan-zoom" role="group" aria-label="Zoom">
              <button type="button" onClick={() => zoomTo(zoom - 0.5)} disabled={zoom <= 1} aria-label="Zoom out" title="Zoom out">
                <Minus />
              </button>
              <span className="tabular-nums">{Math.round(zoom * 100)}%</span>
              <button type="button" onClick={() => zoomTo(zoom + 0.5)} disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" title="Zoom in">
                <Plus />
              </button>
              <button type="button" onClick={() => zoomTo(1)} disabled={zoom <= 1} aria-label="Show the whole hideout" title="Show the whole hideout">
                <Maximize2 />
              </button>
            </div>
          </div>
          <div
            ref={scrollRef}
            className={`tc-plan-scroll ${zoom > 1 ? 'is-zoomed' : ''}`}
            onPointerDown={panStart}
            onPointerMove={panMove}
            onPointerUp={() => (panning.current = null)}
            onPointerCancel={() => (panning.current = null)}
          >
            <HideoutPlan
              zoom={zoom}
              stations={stations}
              infos={infos}
              looks={looks}
              spots={spots}
              selected={selected}
              hover={hover}
              shown={shown}
              names={showNames}
              arrange={arrange}
              dark={light ? darkness(light.level, light.max) : 0}
              lightLevel={light && light.max ? light.level / light.max : 1}
              wallOpen={wallOpen}
              onPick={pick}
              onHover={setHover}
            />
          </div>
          {/* Like the game's bar along the bottom of the overview. */}
          <div className="tc-station-bar" role="list" aria-label="Stations">
            {sorted.map((s) => {
              const info = infos.get(s.id)
              if (!info) return null
              const look = looks.get(s.id) ?? info.state
              return (
                <button
                  key={s.id}
                  type="button"
                  role="listitem"
                  onClick={() => pick(s.id)}
                  onMouseEnter={() => setHover(s.id)}
                  onMouseLeave={() => setHover(null)}
                  aria-pressed={selected === s.id}
                  title={lookLabel(look, info, names)}
                  className={`tc-bar-item tc-st-${look} ${selected === s.id ? 'is-selected' : ''} ${info.level > 0 ? '' : 'is-empty'}`}
                >
                  <span className="tc-bar-hex">{s.imageLink && <img src={s.imageLink} alt="" />}</span>
                  <span className="truncate">{s.name}</span>
                  <span className="tc-bar-num">{String(info.level).padStart(2, '0')}</span>
                </button>
              )
            })}
          </div>
        </div>
        <p className="text-[11px] text-ink-dim">
          The map follows the game's hideout overview; zoom in with + and drag to look around. Stations you have not built yet in the screenshots it was drawn from sit at a best-guess spot; use Move stations to put them right. Hover a station to see what it needs (green built, red missing) and what it opens (gold).
        </p>
      </div>

      <div ref={panelRef} className="scroll-mt-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:self-start xl:overflow-y-auto">
        <StationPanel
          {...props}
          info={selectedInfo}
          look={selectedInfo ? looks.get(selectedInfo.station.id) ?? selectedInfo.state : null}
          timer={selectedInfo ? activeTimer(selectedInfo, timers[selectedInfo.station.id]) : undefined}
          spotSource={selectedInfo ? spots[selectedInfo.station.id]?.source : undefined}
          onArrange={() => setArrange(true)}
          names={names}
          ready={ready}
          onPick={(id) => setSelected(id)}
          onClose={() => setSelected(null)}
        />
      </div>
    </div>
  )
}

import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { ArrowUp, Check, Hourglass } from 'lucide-react'
import type { HideoutStation } from '../api/types'
import type { StationInfo } from '../lib/hideoutState'
import { useHideoutSpots } from '../store/hideoutSpots'
import {
  CIRCLE,
  clampSpot,
  EFFECTS,
  FLOORS,
  LAMPS,
  PLAN_MATRIX,
  planBox,
  project,
  unproject,
  WALL_H,
  wallsInDrawOrder,
  type Effect,
  type Pt,
} from './plan'
import type { Look } from './look'
import type { SpotSource } from './useStationSpots'

/** Station icons float this far above their spot on the floor, like the game's markers. */
const LIFT = 22
const BOX = planBox()
const WALLS = wallsInDrawOrder()
const ROOM_LABELS: { id: string; text: string; sealed?: string }[] = [
  { id: 'range', text: 'Shooting range' },
  { id: 'hidden', text: 'Hidden room', sealed: 'Sealed' },
  { id: 'security', text: 'Entrance' },
  { id: 'cultist', text: 'Circle room' },
]

interface PlanProps {
  /** 1 = fits the frame; the map is drawn this many times wider. */
  zoom: number
  stations: HideoutStation[]
  infos: Map<string, StationInfo>
  looks: Map<string, Look>
  spots: Record<string, { at: Pt; source: SpotSource }>
  selected: string | null
  hover: string | null
  /** Stations not faded (hovered one + what it needs/opens, or the highlighted state). */
  shown: (id: string) => boolean
  names: boolean
  arrange: boolean
  dark: number
  lightLevel: number
  wallOpen: boolean
  onPick: (id: string) => void
  onHover: (id: string | null) => void
}

const pct = ([x, y]: Pt): CSSProperties => ({ left: `${((x - BOX.x) / BOX.w) * 100}%`, top: `${((y - BOX.y) / BOX.h) * 100}%` })
const pts = (list: Pt[]) => list.map((p) => p.join(',')).join(' ')

export function HideoutPlan(props: PlanProps) {
  const { zoom, stations, infos, looks, spots, selected, hover, shown, names, arrange, dark, lightLevel, wallOpen, onPick, onHover } = props
  const box = useRef<HTMLDivElement>(null)
  const move = useHideoutSpots((s) => s.move)
  const [drag, setDrag] = useState<{ id: string; at: Pt } | null>(null)
  const spotOf = (id: string): Pt => (drag?.id === id ? drag.at : spots[id]?.at ?? [0, 0])
  const screen = (id: string): Pt => {
    const [x, y] = project(spotOf(id))
    return [x, y - LIFT]
  }

  const fromPointer = (e: PointerEvent): Pt => {
    const r = box.current!.getBoundingClientRect()
    const x = BOX.x + ((e.clientX - r.left) / r.width) * BOX.w
    const y = BOX.y + ((e.clientY - r.top) / r.height) * BOX.h + LIFT
    return clampSpot(unproject([x, y]))
  }

  const focus = hover ?? selected
  const links = useMemo(() => {
    const info = focus ? infos.get(focus) : undefined
    if (!info) return []
    const me = project(spots[info.station.id]?.at ?? [0, 0])
    const out: { key: string; d: string; kind: 'met' | 'unmet' | 'unlock' }[] = []
    for (const r of info.next?.stationLevelRequirements ?? []) {
      const from = spots[r.stationId]
      if (from) out.push({ key: `in-${r.stationId}`, d: curve(project(from.at), me), kind: info.blockedBy.some((b) => b.stationId === r.stationId) ? 'unmet' : 'met' })
    }
    const seen = new Set<string>()
    for (const u of info.unlocks) {
      const to = spots[u.stationId]
      if (!to || seen.has(u.stationId)) continue
      seen.add(u.stationId)
      out.push({ key: `out-${u.stationId}`, d: curve(me, project(to.at)), kind: 'unlock' })
    }
    return out
  }, [focus, infos, spots])

  const circleBuilt = stations.some((s) => s.normalizedName === 'cultist-circle' && (infos.get(s.id)?.level ?? 0) > 0)
  const lamp = lightLevel > 0 ? 0.25 + 0.75 * lightLevel : 0.12

  return (
    <div ref={box} className={`tc-plan ${arrange ? 'is-arranging' : ''}`} style={{ width: `${zoom * 100}%`, minWidth: 620 * zoom }}>
      <svg viewBox={`${BOX.x} ${BOX.y} ${BOX.w} ${BOX.h}`} className="block h-auto w-full" aria-hidden>
        <defs>
          <pattern id="tc-tiles" patternUnits="userSpaceOnUse" width="1.5" height="1.5">
            <path d="M1.5 0H0V1.5" fill="none" className="tc-tile-line" strokeWidth="0.05" />
          </pattern>
          <radialGradient id="tc-lamp-pool">
            <stop offset="0" stopColor="#ffd69a" stopOpacity="0.55" />
            <stop offset="0.45" stopColor="#ffc277" stopOpacity="0.18" />
            <stop offset="1" stopColor="#ffb060" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="tc-ritual-glow">
            <stop offset="0.55" stopColor="#ff3b2f" stopOpacity="0" />
            <stop offset="0.8" stopColor="#ff3b2f" stopOpacity="0.45" />
            <stop offset="1" stopColor="#ff3b2f" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="tc-shadow">
            <stop offset="0" stopColor="#000" stopOpacity="0.55" />
            <stop offset="1" stopColor="#000" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* Floors, tiles, light and shadows: drawn in plan coordinates through the camera matrix. */}
        <g transform={PLAN_MATRIX}>
          {FLOORS.map((f) => (
            <polygon key={f.id} points={pts(f.points)} className={`tc-floor ${f.hidden && !wallOpen ? 'is-sealed' : ''}`} />
          ))}
          {FLOORS.map((f) => (
            <polygon key={`t-${f.id}`} points={pts(f.points)} fill="url(#tc-tiles)" />
          ))}
          <g opacity={lamp}>
            {LAMPS.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r={3.4} fill="url(#tc-lamp-pool)" className={lightLevel > 0 && lightLevel < 1 ? 'tc-anim-flicker' : ''} style={{ animationDelay: `${(i * 0.37) % 2}s` }} />
            ))}
          </g>
          <circle cx={CIRCLE.at[0]} cy={CIRCLE.at[1]} r={CIRCLE.r} className="tc-chalk" />
          <circle cx={CIRCLE.at[0]} cy={CIRCLE.at[1]} r={CIRCLE.r * 0.72} className="tc-chalk tc-chalk-inner" />
          {circleBuilt && <circle cx={CIRCLE.at[0]} cy={CIRCLE.at[1]} r={CIRCLE.r * 1.25} fill="url(#tc-ritual-glow)" className="tc-anim-breathe tc-slow" style={{ '--lvl': 1 } as CSSProperties} />}
          {stations.map((s) => {
            const [u, v] = spotOf(s.id)
            return <ellipse key={`sh-${s.id}`} cx={u} cy={v} rx={0.9} ry={0.9} fill="url(#tc-shadow)" />
          })}
          {FLOORS.map((f) => (
            <polygon key={`d-${f.id}`} points={pts(f.points)} fill="#000" opacity={dark} />
          ))}
        </g>

        {/* Raised walls, back to front. */}
        {WALLS.map((w, i) => {
          if (w.defective && wallOpen) return null
          const a = project(w.a)
          const b = project(w.b)
          const at = [a[0], a[1] - WALL_H] as Pt
          const bt = [b[0], b[1] - WALL_H] as Pt
          return (
            <g key={i} className={w.defective ? 'tc-wall is-defective' : 'tc-wall'}>
              <polygon points={pts([a, b, bt, at])} className="tc-wall-face" />
              <line x1={at[0]} y1={at[1]} x2={bt[0]} y2={bt[1]} className="tc-wall-edge" />
              <line x1={at[0]} y1={at[1]} x2={bt[0]} y2={bt[1]} className="tc-wall-top" />
            </g>
          )
        })}

        {ROOM_LABELS.map((l) => {
          const floor = FLOORS.find((f) => f.id === l.id)
          if (!floor) return null
          const c = project(centroid(floor.points))
          return (
            <text key={l.id} x={c[0]} y={c[1] + 34} textAnchor="middle" className="tc-room-label">
              {l.sealed && !wallOpen ? l.sealed : l.text}
            </text>
          )
        })}

        {links.map((l) => (
          <g key={l.key} className={`tc-plan-link is-${l.kind}`}>
            {l.kind !== 'unlock' && <path d={l.d} className="tc-link-base" />}
            <path d={l.d} className={`tc-link-flow ${l.kind === 'unlock' ? 'is-out' : ''}`} />
          </g>
        ))}
      </svg>

      {stations.map((s) => {
        const info = infos.get(s.id)
        if (!info) return null
        const look = looks.get(s.id) ?? info.state
        const spot = spots[s.id]
        return (
          <HexMarker
            key={s.id}
            info={info}
            look={look}
            style={pct(screen(s.id))}
            selected={selected === s.id}
            dim={!shown(s.id)}
            sealed={!wallOpen && FLOORS.find((f) => f.id === 'hidden' && inside(f.points, spotOf(s.id))) !== undefined}
            name={names || arrange || hover === s.id || selected === s.id}
            approx={arrange && spot?.source === 'approx'}
            onClick={() => !arrange && onPick(s.id)}
            onHover={onHover}
            onPointerDown={(e) => {
              if (!arrange) return
              e.preventDefault()
              try {
                e.currentTarget.setPointerCapture(e.pointerId)
              } catch {
                /* pointer already gone */
              }
              setDrag({ id: s.id, at: spotOf(s.id) })
            }}
            onPointerMove={(e) => drag?.id === s.id && setDrag({ id: s.id, at: fromPointer(e) })}
            onPointerUp={() => {
              if (drag?.id !== s.id) return
              move(s.normalizedName, drag.at)
              setDrag(null)
            }}
          />
        )
      })}
    </div>
  )
}

function HexMarker({ info, look, style, selected, dim, sealed, name, approx, onClick, onHover, onPointerDown, onPointerMove, onPointerUp }: {
  info: StationInfo
  look: Look
  style: CSSProperties
  selected: boolean
  dim: boolean
  sealed: boolean
  name: boolean
  approx: boolean
  onClick: () => void
  onHover: (id: string | null) => void
  onPointerDown: (e: PointerEvent<HTMLButtonElement>) => void
  onPointerMove: (e: PointerEvent<HTMLButtonElement>) => void
  onPointerUp: () => void
}) {
  const { station, level, max } = info
  const built = level > 0
  const effect = EFFECTS[station.normalizedName] ?? 'none'
  return (
    <button
      type="button"
      data-station={station.id}
      aria-pressed={selected}
      aria-label={`${station.name}, level ${level} of ${max}`}
      className={`tc-hex tc-st-${look} ${built ? 'is-built' : 'is-empty'} ${selected ? 'is-selected' : ''} ${dim ? 'is-dim' : ''} ${sealed ? 'is-sealed' : ''} ${approx ? 'is-approx' : ''}`}
      style={{ ...style, '--lvl': max ? Math.min(level, max) / max : 1 } as CSSProperties}
      onClick={onClick}
      onMouseEnter={() => onHover(station.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(station.id)}
      onBlur={() => onHover(null)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {built && <Aura effect={effect} />}
      <span className="tc-hex-ring" />
      <span className="tc-hex-core">
        {station.imageLink ? <img src={station.imageLink} alt="" draggable={false} className={built ? glyphAnim(effect) : ''} /> : <b>{station.name.slice(0, 1)}</b>}
        {built && effect === 'scan' && <span className="tc-fx-scan" />}
        {built && effect === 'trophy' && <span className="tc-fx-shine" />}
      </span>
      {built && <Below effect={effect} level={level} max={max} />}
      <span className="tc-hex-num">{String(level).padStart(2, '0')}</span>
      <StateBadge look={look} info={info} />
      {name && <span className="tc-hex-name">{station.name}</span>}
    </button>
  )
}

/** Like the game's green arrow on an upgradable station; locked ones only get the grey frame. */
function StateBadge({ look, info }: { look: Look; info: StationInfo }) {
  if (look === 'ready') return <span className="tc-hex-badge" title="Ready to build"><ArrowUp /></span>
  if (look === 'done') return <span className="tc-hex-badge" title="Build timer finished"><Check /></span>
  if (look === 'building') return <span className="tc-hex-badge" title="Building"><Hourglass /></span>
  if (look === 'items') return <span className="tc-hex-badge tc-hex-count" title={`${info.missing.length} items to find`}>{info.missing.length}</span>
  return null
}

/** The glyph itself moves for a few stations (the vents' fan turns, the workbench wrench wiggles). */
function glyphAnim(effect: Effect): string {
  switch (effect) {
    case 'fan':
      return 'tc-anim-spin'
    case 'sun':
      return 'tc-anim-spin tc-slow'
    case 'tools':
      return 'tc-anim-wiggle'
    case 'gym':
      return 'tc-anim-bob'
    case 'med':
      return 'tc-anim-beat'
    case 'range':
      return 'tc-anim-pulse'
    case 'power':
      return 'tc-anim-flicker'
    default:
      return ''
  }
}

const AURA: Partial<Record<Effect, [string, string]>> = {
  power: ['#f2b84b', 'tc-anim-breathe'],
  heat: ['#ff8a3d', 'tc-anim-flicker'],
  ritual: ['#e0453a', 'tc-anim-breathe tc-slow'],
  light: ['#ffd27a', 'tc-anim-breathe tc-slow'],
  rest: ['#7f9dff', 'tc-anim-flicker'],
  scan: ['#3fc1c9', 'tc-anim-breathe'],
  btc: ['#6ee07a', 'tc-anim-breathe tc-slow'],
}

/** A coloured glow behind the hexagon. */
function Aura({ effect }: { effect: Effect }) {
  const a = AURA[effect]
  return a ? <span className={`tc-fx-aura ${a[1]}`} style={{ '--fx': a[0] } as CSSProperties} /> : null
}

/** Little things under the hexagon: water drips, the bitcoin farm's lights, bubbles from the still. */
function Below({ effect, level, max }: { effect: Effect; level: number; max: number }) {
  switch (effect) {
    case 'water':
      return (
        <>
          <span className="tc-fx-drip" style={{ '--fx': '#5fb4ff' } as CSSProperties} />
          <span className="tc-fx-drip tc-fx-late" style={{ '--fx': '#5fb4ff' } as CSSProperties} />
        </>
      )
    case 'btc':
      return (
        <span className="tc-fx-leds">
          {Array.from({ length: Math.max(3, max) }, (_, i) => (
            <i key={i} className={i < level ? 'on' : ''} />
          ))}
        </span>
      )
    case 'booze':
    case 'food':
      return (
        <span className={`tc-fx-bubbles ${effect === 'food' ? 'tc-fx-steam' : ''}`} style={{ '--fx': effect === 'food' ? '#d9d4c7' : '#d7b56d' } as CSSProperties}>
          <i />
          <i />
          <i />
        </span>
      )
    case 'cam':
      return <span className="tc-fx-rec" />
    default:
      return null
  }
}

function centroid(points: Pt[]): Pt {
  const n = points.length
  return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n]
}

/** Point in polygon (even-odd). */
function inside(poly: Pt[], [x, y]: Pt): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

/** A gentle arc between two spots on the floor, stopping short of the markers. */
function curve(a: Pt, b: Pt): string {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const x1 = a[0] + ux * 16
  const y1 = a[1] + uy * 16
  const x2 = b[0] - ux * 18
  const y2 = b[1] - uy * 18
  const bend = Math.min(90, len * 0.2)
  const f = (n: number) => Math.round(n * 10) / 10
  return `M${f(x1)},${f(y1)} Q${f((x1 + x2) / 2 + uy * bend)},${f((y1 + y2) / 2 - ux * bend)} ${f(x2)},${f(y2)}`
}

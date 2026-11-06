import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { GripHorizontal, X } from 'lucide-react'
import { clampPos, MIN_H, MIN_W, nudgeInto, type BoxPos, type Point } from './boxes'
import { useFrame } from './frameContext'
import { useOverlayPrefs } from './overlayPrefs'
import { useDrag, type DragProps } from './shell'

interface BoxProps {
  /** Saved spot and size under this id (boxes.ts). */
  id: string
  /** Where it opens until it is moved (window offsets from anchorStyle). */
  place: CSSProperties
  title?: ReactNode
  /** More buttons in the move bar. */
  actions?: ReactNode
  onClose?: () => void
  /** Width before any resize (page pixels, scaled by the size setting). */
  width?: number
  /** Height cap before any resize (page pixels, scaled). */
  maxHeight?: number
  resizable?: boolean
  /** The box draws its own frame and puts the move handle where it wants (the map card). */
  custom?: (move: DragProps) => ReactNode
  children?: ReactNode
}

/**
 * One box of the search bar (a card, the map, a side panel): drag its move bar to put it anywhere
 * on the screen, drag the corner to resize it. Both are remembered for next time.
 */
export function Box({ id, place, title, actions, onClose, width, maxHeight, resizable = true, custom, children }: BoxProps) {
  const { frame, zoom } = useFrame()
  const saved = useOverlayPrefs((p) => p.boxes[id])
  const setBox = useOverlayPrefs((p) => p.setBox)
  const ref = useRef<HTMLElement>(null)
  const [live, setLive] = useState<BoxPos | null>(null)
  const start = useRef<BoxPos>({ x: 0, y: 0 })
  const last = useRef<BoxPos | null>(null)
  const pos = live ?? (saved ? clampPos(saved, frame) : null)
  // A box at its opening spot is shifted back onto the screen when it (or its content) would stick out.
  const [nudge, setNudge] = useState<Point>({ x: 0, y: 0 })
  const nudgeRef = useRef(nudge)
  const placeKey = JSON.stringify(place)
  const moved = Boolean(pos)
  useLayoutEffect(() => {
    const el = ref.current
    if (moved || !el) return
    const fit = () => {
      const r = el.getBoundingClientRect()
      const was = nudgeRef.current
      const n = nudgeInto({ x: r.left - was.x, y: r.top - was.y, width: r.width, height: r.height }, window.innerWidth, window.innerHeight)
      if (n.x === was.x && n.y === was.y) return
      nudgeRef.current = n
      setNudge(n)
    }
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [moved, placeKey, frame])

  /** Where the box is on the screen right now (it may still be at its opening spot). */
  const here = (): BoxPos => {
    const r = ref.current?.getBoundingClientRect()
    return r ? { x: Math.round(frame.x + r.left), y: Math.round(frame.y + r.top), w: Math.round(r.width), h: Math.round(r.height) } : { x: frame.x, y: frame.y }
  }
  const show = (p: BoxPos) => {
    const c = clampPos(p, frame)
    last.current = c
    setLive(c)
  }
  const finish = () => {
    if (last.current) setBox(id, last.current)
    last.current = null
    setLive(null)
  }
  const move = useDrag({
    onStart: () => {
      const h = here()
      start.current = { x: h.x, y: h.y, w: pos?.w, h: pos?.h }
    },
    onMove: (dx, dy) => show({ ...start.current, x: start.current.x + dx, y: start.current.y + dy }),
    onEnd: finish,
  })
  const resize = useDrag({
    onStart: () => {
      start.current = here()
    },
    onMove: (dx, dy) => show({ ...start.current, w: Math.max(MIN_W, (start.current.w ?? MIN_W) + dx), h: Math.max(MIN_H, (start.current.h ?? MIN_H) + dy) }),
    onEnd: finish,
  })

  const style: CSSProperties = pos ? { left: pos.x - frame.x, top: pos.y - frame.y, width: pos.w, height: pos.h } : nudge.x || nudge.y ? { ...place, translate: `${nudge.x}px ${nudge.y}px` } : place
  // A box moved low on the screen gets shorter, so its bottom never ends up off the screen.
  const room = pos && !pos.h ? Math.max(80, (frame.y + frame.height - pos.y - 36 * zoom) / zoom) : undefined
  const bodyMax = maxHeight === undefined ? room : room === undefined ? maxHeight : Math.min(maxHeight, room)
  const grip = resizable && (
    <span {...resize} title="Drag to resize" aria-label="Resize" className="absolute bottom-0 right-0 z-[1100] flex h-4 w-4 cursor-nwse-resize touch-none items-end justify-end p-0.5 text-white/35 hover:text-white">
      <svg viewBox="0 0 8 8" className="h-2.5 w-2.5" aria-hidden>
        <path d="M7 1 1 7M7 4 4 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </span>
  )

  if (custom)
    return (
      <section ref={ref} data-solid className="absolute" style={style}>
        {custom(move)}
        {grip}
      </section>
    )
  return (
    <section ref={ref} data-solid className="sb-z absolute flex flex-col overflow-hidden rounded-lg border border-white/15 bg-black/85 shadow-2xl" style={style}>
      <div className="flex min-h-0 flex-1 flex-col" style={{ zoom, width: pos?.w ? '100%' : width, height: pos?.h ? '100%' : undefined }}>
        <header {...move} title="Drag to move" className="flex shrink-0 cursor-move touch-none select-none items-center gap-1 border-b border-white/10 py-1 pl-1.5 pr-2">
          <GripHorizontal className="h-3.5 w-3.5 shrink-0 text-white/35" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-wide text-white/55">{title}</span>
          {actions}
          {onClose && (
            <button type="button" onClick={onClose} title="Close" aria-label="Close" className="p-0.5 text-white/45 hover:text-white">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5 [scrollbar-width:thin]" style={!pos?.h && bodyMax !== undefined ? { maxHeight: bodyMax } : undefined}>
          {children}
        </div>
      </div>
      {grip}
    </section>
  )
}

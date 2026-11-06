import { useEffect, useRef, useState } from 'react'

type Point = { x: number; y: number }
export type SnipBox = { x: number; y: number; w: number; h: number }

/** Smaller than this (page pixels) is a slip of the mouse, not a box. */
const MIN_BOX = 12

/**
 * Covers the screen with a still picture of it (taken with the bar hidden): drag a box around the
 * stash or container slots to scan. Esc or a right-click cancels. `onDone` gets the box in the
 * picture's own pixels.
 */
export function SnipLayer({ url, onDone, onCancel }: { url: string; onDone: (box: SnipBox) => void; onCancel: () => void }) {
  const img = useRef<HTMLImageElement>(null)
  const [start, setStart] = useState<Point | null>(null)
  const [cur, setCur] = useState<Point | null>(null)

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onCancel])

  const rect = start && cur ? { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) } : null

  const finish = (e: React.PointerEvent) => {
    const el = img.current
    const x1 = start ? Math.min(start.x, e.clientX) : 0
    const y1 = start ? Math.min(start.y, e.clientY) : 0
    const w = start ? Math.abs(e.clientX - start.x) : 0
    const h = start ? Math.abs(e.clientY - start.y) : 0
    if (!el?.naturalWidth || !el.clientWidth || !el.clientHeight || w < MIN_BOX || h < MIN_BOX) {
      setStart(null)
      setCur(null)
      return
    }
    // Page pixels → picture pixels (the picture fills the window; Windows scaling makes it larger).
    const sx = el.naturalWidth / el.clientWidth
    const sy = el.naturalHeight / el.clientHeight
    const x = Math.max(0, Math.round(x1 * sx))
    const y = Math.max(0, Math.round(y1 * sy))
    onDone({ x, y, w: Math.min(el.naturalWidth - x, Math.round(w * sx)), h: Math.min(el.naturalHeight - y, Math.round(h * sy)) })
  }

  return (
    <div
      data-solid
      className="fixed inset-0 z-[10000] cursor-crosshair touch-none select-none"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          // the layer covers the whole screen anyway
        }
        setStart({ x: e.clientX, y: e.clientY })
        setCur({ x: e.clientX, y: e.clientY })
      }}
      onPointerMove={(e) => {
        if (start) setCur({ x: e.clientX, y: e.clientY })
      }}
      onPointerUp={finish}
      onPointerCancel={onCancel}
      onContextMenu={(e) => {
        e.preventDefault()
        onCancel()
      }}
    >
      <img ref={img} src={url} alt="" draggable={false} className="pointer-events-none absolute inset-0 h-full w-full" />
      {rect ? (
        <div className="pointer-events-none absolute border-2 border-amber-300" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, boxShadow: '0 0 0 100vmax rgba(0,0,0,0.5)' }}>
          {rect.w >= MIN_BOX && rect.h >= MIN_BOX && (
            <span className="absolute -top-6 left-0 whitespace-nowrap rounded bg-black/80 px-1.5 py-0.5 text-[11px] text-amber-200">Let go to scan</span>
          )}
        </div>
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-black/40" />
      )}
      <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-white/15 bg-black/85 px-4 py-1.5 text-[13px] text-white shadow-2xl">
        Drag a box around the slots to check · <span className="text-white/60">Esc or right-click cancels</span>
      </div>
    </div>
  )
}

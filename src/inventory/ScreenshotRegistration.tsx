import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { Grid } from '../scan/core'
import { checkedCrop, cropForGrid, type ImageCrop } from '../scan/registration'

export interface StagedScreenshot {
  blob: Blob
  hash: string
  width: number
  height: number
}

const inputClass = 'w-24 rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink'

export function ScreenshotRegistration({ image, columns, rows, busy, hasDraftRows, onScan, onDismiss }: {
  image: StagedScreenshot
  columns: number
  rows: number
  busy: boolean
  hasDraftRows: boolean
  onScan: (crop: ImageCrop, grid?: Grid) => Promise<Grid | undefined>
  onDismiss: () => void
}) {
  const preview = useRef<SVGImageElement>(null)
  const [crop, setCrop] = useState<ImageCrop>(() => checkedCrop(null, image))
  const [manual, setManual] = useState(false)
  const [grid, setGrid] = useState<Grid>(() => ({
    ox: 0, oy: 0, cols: columns, rows,
    pitch: Math.min((image.width - 1) / columns, (image.height - 1) / rows),
  }))
  const [detected, setDetected] = useState<Grid | undefined>()
  const [replaceRows, setReplaceRows] = useState(false)
  const drag = useRef<{ x: number; y: number; pointer: number; previous: ImageCrop } | null>(null)
  const active = useRef(true)
  useEffect(() => {
    active.current = true
    const objectUrl = URL.createObjectURL(image.blob)
    const node = preview.current
    node?.setAttribute('href', objectUrl)
    return () => {
      active.current = false
      node?.removeAttribute('href')
      URL.revokeObjectURL(objectUrl)
    }
  }, [image.blob])

  let area: ImageCrop | undefined
  let invalid = ''
  try {
    area = manual ? cropForGrid(grid, image) : checkedCrop(crop, image)
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error)
  }
  const overlay = manual ? !invalid ? grid : undefined : detected

  function changeCrop(next: ImageCrop) {
    setCrop(next)
    setDetected(undefined)
  }
  function point(event: PointerEvent<SVGSVGElement>) {
    const matrix = event.currentTarget.getScreenCTM()
    if (!matrix) return null
    const value = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse())
    return {
      x: Math.max(0, Math.min(image.width, Math.round(value.x))),
      y: Math.max(0, Math.min(image.height, Math.round(value.y))),
    }
  }
  function selection(event: PointerEvent<SVGSVGElement>) {
    const start = drag.current
    const end = point(event)
    if (!start || start.pointer !== event.pointerId || !end) return
    changeCrop({
      x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
      w: Math.abs(start.x - end.x), h: Math.abs(start.y - end.y),
    })
  }
  function toggleManual(next: boolean) {
    if (next) setGrid(detected ?? {
      ox: crop.x, oy: crop.y, cols: columns, rows,
      pitch: Math.min((crop.w - 1) / columns, (crop.h - 1) / rows),
    })
    setManual(next)
    setDetected(undefined)
  }
  async function recognize() {
    if (!area || busy || drag.current || (hasDraftRows && !replaceRows)) return
    setDetected(undefined)
    const result = await onScan(area, manual ? grid : undefined)
    if (active.current) {
      setDetected(result)
      setReplaceRows(false)
    }
  }

  return (
    <section className="space-y-3 border-y border-line py-4" aria-labelledby="screenshot-selection-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="screenshot-selection-title" className="font-semibold">Select one complete container</h3>
        <button className="btn" disabled={busy} onClick={onDismiss}>Close screenshot selection</button>
      </div>
      <p className="max-w-prose text-sm text-ink-muted">
        Drag around the container grid, or enter its area in pixels. Recognition changes draft rows only.
        The accepted inventory stays unchanged until you review and save it.
      </p>
        <svg viewBox={`0 0 ${image.width} ${image.height}`} role="img"
          aria-label="Screenshot with selected container area; numeric controls below provide keyboard access"
          className={`block max-h-[28rem] w-full touch-none border border-line bg-surface ${manual || busy ? '' : 'cursor-crosshair'}`}
          onPointerDown={(event) => {
            if (manual || busy || event.button !== 0 || !event.isPrimary) return
            const start = point(event)
            if (!start) return
            drag.current = { ...start, pointer: event.pointerId, previous: crop }
            event.currentTarget.setPointerCapture(event.pointerId)
            changeCrop({ ...start, w: 0, h: 0 })
          }}
          onPointerMove={(event) => { if (!manual && !busy) selection(event) }}
          onPointerUp={(event) => {
            if (drag.current?.pointer !== event.pointerId) return
            if (!busy) selection(event)
            drag.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }}
          onPointerCancel={() => {
            if (drag.current) changeCrop(drag.current.previous)
            drag.current = null
          }}
        >
          <image ref={preview} width={image.width} height={image.height} pointerEvents="none" />
          {!manual && [crop.x, crop.y, crop.w, crop.h].every(Number.isFinite) && (
            <rect x={crop.x} y={crop.y} width={Math.max(0, crop.w)} height={Math.max(0, crop.h)}
              fill="none" className="stroke-accent" strokeWidth={2} vectorEffect="non-scaling-stroke" pointerEvents="none" />
          )}
          {overlay && (
            <g className="stroke-info" strokeWidth={1} pointerEvents="none">
              {Array.from({ length: overlay.cols + 1 }, (_, column) => (
                <line key={`c:${column}`} x1={overlay.ox + column * overlay.pitch} x2={overlay.ox + column * overlay.pitch}
                  y1={overlay.oy} y2={overlay.oy + overlay.rows * overlay.pitch} vectorEffect="non-scaling-stroke" />
              ))}
              {Array.from({ length: overlay.rows + 1 }, (_, row) => (
                <line key={`r:${row}`} y1={overlay.oy + row * overlay.pitch} y2={overlay.oy + row * overlay.pitch}
                  x1={overlay.ox} x2={overlay.ox + overlay.cols * overlay.pitch} vectorEffect="non-scaling-stroke" />
              ))}
            </g>
          )}
        </svg>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={manual} disabled={busy} onChange={(event) => toggleManual(event.target.checked)} />
        Set the grid manually ({columns} columns × {rows} rows)
      </label>
      <div className="flex flex-wrap items-end gap-3">
        {manual ? (['ox', 'oy', 'pitch'] as const).map((field) => (
          <label key={field} className="grid gap-1 text-xs text-ink-muted">
            {{ ox: 'First grid line X', oy: 'First grid line Y', pitch: 'Cell size (px)' }[field]}
            <input type="number" step="0.1" min={field === 'pitch' ? 1 : 0} className={inputClass}
              disabled={busy} value={Number.isFinite(grid[field]) ? grid[field] : ''}
              onChange={(event) => { setGrid({ ...grid, [field]: event.target.valueAsNumber }); setDetected(undefined) }} />
          </label>
        )) : (['x', 'y', 'w', 'h'] as const).map((field) => (
          <label key={field} className="grid gap-1 text-xs text-ink-muted">
            {{ x: 'Area X', y: 'Area Y', w: 'Area width', h: 'Area height' }[field]}
            <input type="number" step={1} min={field === 'x' || field === 'y' ? 0 : 1} className={inputClass}
              disabled={busy} value={Number.isFinite(crop[field]) ? crop[field] : ''}
              onChange={(event) => changeCrop({ ...crop, [field]: event.target.valueAsNumber })} />
          </label>
        ))}
        {!manual && <button className="btn" disabled={busy} onClick={() => changeCrop(checkedCrop(null, image))}>Use whole image</button>}
      </div>
      {overlay && <p className="text-xs text-ink-muted">Grid: {overlay.cols}×{overlay.rows} · cell size {overlay.pitch.toFixed(2)} px. Check that the lines match the container.</p>}
      {invalid && <p role="alert" className="text-sm text-danger">{invalid}</p>}
      {hasDraftRows && (
        <label className="flex gap-2 text-sm">
          <input type="checkbox" checked={replaceRows} disabled={busy} onChange={(event) => setReplaceRows(event.target.checked)} />
          Replace this draft's current rows with the new recognition result.
        </label>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn" disabled={busy || !!invalid || (hasDraftRows && !replaceRows)} onClick={() => void recognize()}>
          {busy ? 'Recognizing selected container…' : 'Recognize selected container'}
        </button>
        <p className="text-xs text-ink-muted">A selection does not confirm full coverage, quantities or FIR.</p>
      </div>
    </section>
  )
}

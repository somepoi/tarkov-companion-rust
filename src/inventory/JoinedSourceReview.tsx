import { decodeScreenshot } from '../scan/imageBudget'
import { useEffect, useState } from 'react'
import { checkedCrop } from '../scan/registration'
import { readArchivedScreenshot, type JoinedSource } from './client'

/** One archived source at a time; decoded pixels and URLs have bounded lifetimes. */
export function JoinedSourceReview({ sources }: { sources: JoinedSource[] }) {
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const source = sources[Math.min(index, Math.max(0, sources.length - 1))]
  return source ? <div className="space-y-2" aria-label="Original footprint fragments">
    <label className="grid gap-1 text-xs">Original source fragment
      <select className="max-w-full rounded border border-line bg-surface px-2 py-1.5 text-sm" disabled={loading} value={Math.min(index, sources.length - 1)} onChange={(event) => { setLoading(true); setIndex(Number(event.target.value)) }}>
        {sources.map((entry, at) => <option key={`${entry.viewId}:${entry.stackId}`} value={at}>Fragment {at + 1}: view at {entry.viewColumn},{entry.viewRow} · local cell {entry.location.column},{entry.location.row}</option>)}
      </select>
    </label>
    <SourceImage key={JSON.stringify(source)} source={source} onLoading={setLoading} />
    <p className="text-xs text-ink-muted">Inspect every fragment. Loading pixels does not confirm identity, amount, FIR or that the container layout stayed unchanged.</p>
  </div> : null
}

function SourceImage({ source: initial, onLoading }: { source: JoinedSource; onLoading: (value: boolean) => void }) {
  // The parent keys this component by the complete immutable source registration.
  const [source] = useState(initial)
  const [image, setImage] = useState<{ url: string; width: number; height: number; area: { x: number; y: number; w: number; h: number } } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    onLoading(true)
    let url: string | undefined
    void readArchivedScreenshot(source.screenshotHash).then(async (blob) => {
      if (!active) return
      const bitmap = await decodeScreenshot(blob)
      const { width, height } = bitmap
      bitmap.close()
      if (!active) return
      const grid = source.sourceGrid
      const location = source.location
      const x = grid ? Math.floor(grid.ox + location.column * grid.pitch) : 0
      const y = grid ? Math.floor(grid.oy + location.row * grid.pitch) : 0
      const area = checkedCrop(grid ? { x, y,
        w: Math.ceil(grid.ox + (location.column + location.width) * grid.pitch + 1) - x,
        h: Math.ceil(grid.oy + (location.row + location.height) * grid.pitch + 1) - y } : null, { width, height })
      url = URL.createObjectURL(blob)
      setImage({ url, width, height, area })
    }).catch((cause: unknown) => { if (active) setError(`Cannot show this archived fragment: ${cause instanceof Error ? cause.message : String(cause)}`) })
      .finally(() => { if (active) onLoading(false) })
    return () => { active = false; if (url) URL.revokeObjectURL(url) }
  }, [source, onLoading])
  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>
  if (!image) return <p role="status" className="text-xs text-ink-muted">Loading original fragment…</p>
  return <div>
    <svg role="img" aria-label={source.sourceGrid ? 'Archived pixels of this clipped fragment' : 'Whole archived screenshot; this manual source has no pixel registration'}
      viewBox={`${image.area.x} ${image.area.y} ${image.area.w} ${image.area.h}`} className="max-h-64 w-full border border-line bg-surface">
      <image href={image.url} width={image.width} height={image.height} />
    </svg>
    {!source.sourceGrid && <p className="text-xs text-ink-muted">Whole screenshot shown: this manual source has no registered pixel crop.</p>}
  </div>
}

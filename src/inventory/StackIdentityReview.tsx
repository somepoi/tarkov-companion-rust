import { useEffect, useMemo, useRef, useState } from 'react'
import type { ItemsById } from '../api/types'
import { recordFromSpot, useLearnedStore } from '../scan/learned'
import { readArchivedScreenshot, type Observation, type Stack } from './client'

const inputClass = 'rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink'

/** One expanded reviewer at a time: archived pixels and explicit identity choices. */
export function StackIdentityReview({ stack, observation, items, onChange, onClose }: {
  stack: Stack
  observation: Observation | undefined
  items: ItemsById | undefined
  onChange: (patch: Partial<Stack>) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [evidence, setEvidence] = useState<{ blob: Blob; url: string; width: number; height: number } | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const screenshotHash = observation?.screenshotHash
  useEffect(() => {
    alive.current = true
    let active = true
    let url: string | undefined
    if (screenshotHash) {
      void readArchivedScreenshot(screenshotHash).then(async (blob) => {
        if (!active) return
        const bitmap = await createImageBitmap(blob)
        const { width, height } = bitmap
        bitmap.close()
        if (!active) return
        url = URL.createObjectURL(blob)
        setEvidence({ blob, url, width, height })
      }).catch((cause: unknown) => {
        if (active) setError(`Cannot load screenshot evidence: ${String(cause)}`)
      })
    }
    return () => {
      active = false
      alive.current = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [screenshotHash])
  const choices = useMemo(() => {
    if (query.trim().length < 2) return []
    const text = query.trim().toLowerCase()
    return Object.values(items ?? {}).filter((item) =>
      `${item.name} ${item.shortName}`.toLowerCase().includes(text),
    ).slice(0, 12)
  }, [query, items])
  const grid = observation?.sourceGrid
  const location = stack.location
  const x = grid ? grid.ox + location.column * grid.pitch : 0
  const y = grid ? grid.oy + location.row * grid.pitch : 0
  const width = grid ? location.width * grid.pitch + 1 : 0
  const height = grid ? location.height * grid.pitch + 1 : 0
  const validPatch = !!grid && !!evidence && [x, y, width, height].every(Number.isFinite)
    && x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= evidence.width && y + height <= evidence.height
  const choose = (itemId: string | null) => {
    onChange({
      itemId,
      provenance: { ...stack.provenance, identityConfirmed: false, corrected: true },
    })
    setNote('Identity changed. Confirm it after checking the screenshot; amount and FIR are separate.')
  }
  async function remember() {
    if (busy || !evidence || !grid || !observation || !stack.itemId || !stack.provenance.identityConfirmed) return
    setBusy(true)
    setError('')
    setNote('')
    try {
      const original = observation.candidates[0]?.itemId
      const kind = original === stack.itemId ? 'confirmed' : 'correct'
      const record = await recordFromSpot(evidence.blob, grid, {
        itemId: original ?? stack.itemId,
        col: location.column, row: location.row, w: location.width, h: location.height,
        rotated: location.rotated, error: 0, alternatives: [],
      }, location.width, location.height, stack.itemId, kind)
      if (!record) throw new Error('The complete item footprint must be inside the screenshot grid. Check its position and size before remembering it.')
      if (!alive.current) return
      // Repeated clicks on this reviewed patch replace the same reference.
      record.id = `stash:${observation.screenshotHash}:${JSON.stringify(grid)}:${JSON.stringify(location)}:${stack.itemId}`
      await useLearnedStore.getState().addPersisted(record)
      if (alive.current) setNote('Appearance saved locally for future scans. A learned match still requires review.')
    } catch (cause) {
      if (alive.current) setError(`Appearance was not saved: ${cause instanceof Error ? cause.message : String(cause)}`)
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  return (
    <section className="space-y-3 border-y border-line py-4" aria-label="Review stack identity">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold">Review {items?.[stack.itemId ?? '']?.name ?? 'unknown item'} · cell {location.column}, {location.row}</h3>
        <button className="btn" disabled={busy} onClick={onClose}>Close item review</button>
      </div>
      <div className="flex flex-wrap items-start gap-4">
        {evidence && validPatch ? (
          <svg role="img" aria-label="Archived screenshot at this stack's position" viewBox={`${x} ${y} ${width} ${height}`}
            className="h-48 max-w-full border border-line bg-surface" style={{ width: Math.min(320, 192 * width / height) }}>
            <image href={evidence.url} width={evidence.width} height={evidence.height} />
          </svg>
        ) : <p className="max-w-sm text-sm text-ink-muted">{!observation ? 'Manual stack: no screenshot evidence.' : !grid ? 'This older draft has no pixel registration. You can correct its identity, or reimport the screenshot to remember its appearance.' : !evidence && !error ? 'Loading archived screenshot…' : 'The selected footprint is outside the archived image. Check its column, row and size.'}</p>}
        <div className="min-w-0 flex-1 space-y-2">
          {!!observation?.candidates.length && <div className="flex flex-wrap gap-2">
            {observation.candidates.map((candidate, index) => (
              <button key={`${candidate.itemId}:${index}`} className="btn text-xs" disabled={busy} onClick={() => choose(candidate.itemId)}>
                {items?.[candidate.itemId]?.shortName ?? candidate.itemId} · error {candidate.error.toFixed(3)}
              </button>
            ))}
          </div>}
          <p className="text-xs text-ink-dim">Lower match error is better; it is not a probability.</p>
          <label className="grid gap-1 text-sm">
            Replace with an item
            <input className={inputClass} value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} placeholder="Search at least two characters" />
          </label>
          <div className="flex flex-wrap gap-2">
            {choices.map((item) => <button key={item.id} className="btn text-xs" disabled={busy} onClick={() => choose(item.id)}>{item.name}</button>)}
            {query.trim().length >= 2 && choices.length === 0 && <p className="text-sm text-ink-muted">No matching catalog items.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn" disabled={busy} onClick={() => choose(null)}>Mark identity unknown</button>
            <button className="btn" disabled={busy || !validPatch || !stack.itemId || !stack.provenance.identityConfirmed} onClick={() => void remember()}>
              {busy ? 'Saving appearance…' : 'Remember confirmed appearance'}
            </button>
          </div>
          <p className="text-xs text-ink-muted">Confirm this stack's identity before remembering. Adjust the footprint if needed; choosing an item does not change its position or size.</p>
        </div>
      </div>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {note && <p role="status" className="text-sm text-ink-muted">{note}</p>}
    </section>
  )
}

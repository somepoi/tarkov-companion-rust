import { useEffect, useRef, useState } from 'react'
import { readArchivedScreenshot, type Container, type RegisteredView, type ScanDraft } from './client'
import type { AlignmentResponse } from './alignViewPixels'

export function ViewAlignment({ views, draft, imageHash, viewSize, container, ready, run, onApply }: {
  views: RegisteredView[]; draft: ScanDraft; imageHash: string
  viewSize: { columns: number; rows: number }; container: Container; ready: boolean
  run: (job: () => Promise<void>) => Promise<unknown>
  onApply: (origin: { column: number; row: number }) => void
}) {
  const [selected, setSelected] = useState(views[0]?.id ?? '')
  const [result, setResult] = useState<{ basis: string; draft: ScanDraft; reference: RegisteredView; response: AlignmentResponse } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort() } }, [])
  const reference = views.find((view) => view.id === selected) ?? views[0]
  const basis = `${imageHash}:${viewSize.columns}:${viewSize.rows}:${container.columns}:${container.rows}`
  const current = result?.basis === basis && result.draft === draft && result.reference === reference ? result.response : null
  async function find() {
    if (!reference || !ready) return
    const abort = new AbortController()
    controller.current = abort
    setResult(null)
    try {
      const [{ alignmentSource, suggestAlignment }, currentImage, referenceImage] = await Promise.all([
        import('./alignViewPixels'), readArchivedScreenshot(imageHash), readArchivedScreenshot(reference.screenshotHash),
      ])
      if (!alive.current || abort.signal.aborted) return
      const response = await suggestAlignment({
        current: alignmentSource(currentImage, imageHash, draft, viewSize.columns, viewSize.rows),
        reference: { ...alignmentSource(referenceImage, reference.screenshotHash, reference.draft, reference.columns, reference.rows), column: reference.column, row: reference.row },
        container: { columns: container.columns, rows: container.rows },
      }, abort.signal)
      if (alive.current && !abort.signal.aborted) setResult({ basis, draft, reference, response })
    } finally { if (controller.current === abort) controller.current = null }
  }
  return <div className="space-y-2 border-l-2 border-line pl-3" aria-label="Screenshot position hint">
    <div className="flex flex-wrap items-end gap-2">
      <label className="grid gap-1 text-xs">Compare pixels with
        <select className="rounded border border-line bg-surface px-2 py-1.5 text-sm" disabled={!ready || !views.length}
          value={reference?.id ?? ''} onChange={(event) => { setSelected(event.target.value); setResult(null) }}>
          {views.map((view, index) => <option key={view.id} value={view.id}>Saved view {index + 1} at {view.column},{view.row}</option>)}
        </select>
      </label>
      <button className="btn" disabled={!ready || !reference} onClick={() => void run(find)}>Suggest starting position</button>
    </div>
    <p className="max-w-prose text-xs text-ink-muted">Compares exact pixels in reviewed item footprints, without matching item IDs. Duplicate or changed patches may leave no hint. Confirm positions yourself; overlap choices and item counts remain separate.</p>
    {current && <p role="status" className="text-xs text-ink-muted">{current.message}</p>}
    {current?.proposal && <div className="flex flex-wrap items-center gap-3 text-sm">
      <span>Suggested start: {current.proposal.column},{current.proposal.row} · {current.proposal.matchedPatches} distinct matching patches · {current.proposal.overlapCells} overlapping cells</span>
      <button className="btn" disabled={!ready} onClick={() => { if (current.proposal) onApply({ column: current.proposal.column, row: current.proposal.row }); setResult(null) }}>Use suggested position</button>
    </div>}
  </div>
}

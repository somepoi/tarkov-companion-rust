import { useEffect, useRef, useState } from 'react'
import { composeViews, saveComposition, getComposition, commitPartial, inventoryCall, type ScanComposition, type CompositionPreview, type ScanSession, type Container, type ScanDraft, type CommitResult, type RegisteredView } from './client'

const empty = (): ScanComposition => ({ stableLayoutConfirmed: false, views: [], choices: [] })
const field = 'rounded border border-line bg-surface px-2 py-1 text-sm text-ink'
export function MultiViewPanel({ session, container, draft, imageHash, viewSize, busy, run, validDraft, onEdit, onApply, onCommitted }: {
  session: ScanSession; container: Container; draft: ScanDraft; imageHash?: string
  viewSize: { columns: number; rows: number }; busy: boolean
  run: (job: () => Promise<void>) => Promise<unknown>
  validDraft: (draft: ScanDraft) => boolean
  onEdit: (view: RegisteredView) => Promise<void>
  onApply: (draft: ScanDraft) => void; onCommitted: (result: CommitResult) => Promise<void>
}) {
  const [composition, setComposition] = useState<ScanComposition>(empty)
  const [preview, setPreview] = useState<CompositionPreview | null>(null)
  const [origin, setOrigin] = useState({ column: 0, row: 0 })
  const [coverage, setCoverage] = useState(false)
  const [coverageDraft, setCoverageDraft] = useState<ScanDraft | null>(null)
  const [coverageImage, setCoverageImage] = useState<string | undefined>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [approved, setApproved] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const alive = useRef(true)
  const key = useRef(crypto.randomUUID())
  const stagedKey = useRef<string | null>(null)
  useEffect(() => {
    alive.current = true
    void getComposition(session.id).then((saved) => { if (alive.current && saved) setComposition(saved) }).catch((error: unknown) => { if (alive.current) { setLoadFailed(true); setMessage(String(error)) } }).finally(() => { if (alive.current) setLoading(false) })
    return () => { alive.current = false }
  }, [session.id])
  const change = (next: ScanComposition) => { setComposition(next); setPreview(null); setApproved(false); key.current = crypto.randomUUID(); stagedKey.current = null }
  const execute = (job: () => Promise<void>) => { void run(job) }
  const ready = !busy && !loading && !loadFailed
  const coverageValid = coverage && coverageDraft === draft && coverageImage === imageHash
  const inspect = async () => {
    if (editingId) throw new Error('Replace or cancel the current view edit before checking composition')
    const result = await composeViews(session.id, composition)
    if (alive.current) { setPreview(result); setApproved(false) }
  }
  const add = () => {
    if (editingId && !composition.views.some((view) => view.id === editingId)) { setEditingId(null); setMessage('The edited view was removed. Add it as a new view.'); return }
    if (!imageHash || !coverageValid || !draft.reviewConfirmed || !validDraft(draft)) { setMessage('Review the current screenshot rows and confirm its visible coverage first.'); return }
    const local = structuredClone(draft)
    for (const stack of local.stacks) if (stack.provenance.screenshotHash === null) {
      stack.provenance = { ...stack.provenance, screenshotHash: imageHash, observationId: null, method: 'manual-view-registration' }
    }
    const view = { id: editingId ?? crypto.randomUUID(), screenshotHash: imageHash, ...origin, ...viewSize, coverageConfirmed: true, draft: local }
    change({ ...composition, stableLayoutConfirmed: false, views: editingId ? composition.views.map((old) => old.id === editingId ? view : old) : [...composition.views, view], choices: [] }); setEditingId(null); setCoverage(false); setMessage('View added in memory. Save registered views to retain it before leaving this scan.')
  }
  const choose = (column: number, row: number, viewId: string) => change({ ...composition, choices: [...composition.choices.filter((c) => c.column !== column || c.row !== row), { column, row, viewId }] })
  return <section className="space-y-3 border-y border-line py-4" aria-label="Registered screenshot views">
    <h3 className="font-semibold">Combine screenshot views</h3>
    <p className="max-w-prose text-sm text-ink-muted">Use one unchanged container layout. Coordinates start at zero. Reviewing a saved view replaces the current editor. Add or replace a view to keep its changes. Review the current screenshot below before adding it; a repeated icon never proves that two stacks are the same.</p>
    <div className="flex flex-wrap items-end gap-3">
      {(['column', 'row'] as const).map((axis) => <label key={axis} className="text-sm">Starting {axis}<input className={`${field} ml-2 w-20`} type="number" min={0} max={container[axis === 'column' ? 'columns' : 'rows'] - viewSize[axis === 'column' ? 'columns' : 'rows']} value={origin[axis]} disabled={!ready} onChange={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n >= 0) { setOrigin({ ...origin, [axis]: n }); setCoverage(false) } }} /></label>)}
      <button className="btn" disabled={!ready || (!editingId && composition.views.length >= 32) || !imageHash || !coverageValid || !draft.reviewConfirmed || !validDraft(draft)} onClick={add}>{editingId ? 'Replace reviewed view' : 'Add reviewed view'}</button>
    </div>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={coverageValid} disabled={!ready} onChange={(e) => { setCoverage(e.target.checked); setCoverageDraft(draft); setCoverageImage(imageHash) }} />I checked every visible cell in this screenshot, including empty cells and clipped edges.</label>
    {editingId && <button className="btn" disabled={!ready} onClick={() => { setEditingId(null); setPreview(null); setApproved(false) }}>Cancel view edit</button>}
    {message && <p role="status" className="text-sm text-ink-muted">{message}</p>}
    {composition.views.map((view, index) => <div key={view.id} className="flex flex-wrap items-center justify-between gap-2 text-sm"><button className="btn" disabled={!ready} onClick={() => execute(async () => { setPreview(null); setApproved(false); await onEdit(view); if (alive.current) { setEditingId(view.id); setOrigin({ column: view.column, row: view.row }); setCoverage(false) } })}>Review view {index + 1}</button><span>View {index + 1}: {view.columns}×{view.rows} at {view.column},{view.row} · {view.draft.stacks.length} stacks</span><button className="btn" disabled={!ready} onClick={() => {
      const choices = new Map(composition.choices.map((cell) => [`${cell.column}:${cell.row}`, cell]))
      for (let row = view.row; row < view.row + view.rows; row++) for (let column = view.column; column < view.column + view.columns; column++) choices.set(`${column}:${row}`, { column, row, viewId: view.id })
      change({ ...composition, choices: [...choices.values()] })
    }}>Use view {index + 1} for its covered cells</button><button className="btn" disabled={!ready} onClick={() => { if (editingId === view.id) setEditingId(null); change({ ...composition, stableLayoutConfirmed: false, views: composition.views.filter((v) => v.id !== view.id), choices: [] }) }}>Remove view {index + 1}</button></div>)}
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={composition.stableLayoutConfirmed} disabled={!ready} onChange={(e) => change({ ...composition, stableLayoutConfirmed: e.target.checked })} />All views show the same container without moving, consuming or transferring items between captures.</label>
    <div className="flex flex-wrap gap-2"><button className="btn" disabled={!ready || !composition.views.length} onClick={() => execute(async () => { await inventoryCall({ operation: 'saveDraft', sessionId: session.id, draft }); await saveComposition(session.id, composition); if (alive.current) setMessage('Registered views saved.') })}>Save registered views</button><button className="btn" disabled={!ready || !composition.views.length || Boolean(editingId)} onClick={() => execute(inspect)}>Check coverage and overlaps</button></div>
    {preview && <>
      <p className="text-sm">Coverage: {preview.coveredCells}/{preview.totalCells} cells · unresolved overlaps: {preview.unresolvedCells} · split footprints: {preview.splitStacks.length}</p>
      {preview.conflicts.slice(0, 32).map((cell) => <label className="block text-sm" key={`${cell.column}:${cell.row}`}>Cell {cell.column},{cell.row}: authoritative view <select className={`${field} ml-2`} disabled={!ready} value="" onChange={(e) => choose(cell.column, cell.row, e.target.value)}><option value="" disabled>Select source</option>{cell.viewIds.map((id) => <option key={id} value={id}>View {composition.views.findIndex((v) => v.id === id) + 1}</option>)}</select></label>)}
      {preview.unresolvedCells > 32 && <p className="text-xs text-ink-muted">Resolve this batch, then check again to show the next unresolved cells.</p>}
      {preview.splitStacks.length > 0 && <p role="alert" className="text-sm text-danger">The choices split an item footprint. Remove a conflicting view or revise cell choices; no partial item can be counted.</p>}
      {preview.draft && <>
        <p className="text-sm text-ink-muted">{preview.draft.stacks.length} selected stacks. Unseen baseline stacks are retained by a partial update. A boundary crossing an existing stack will reject the commit. Partial results remain incomplete and cannot authorize SELL.</p>
        {session.scope === 'full' ? <button className="btn" disabled={!ready || !preview.draft.fullCoverageConfirmed || !preview.draft.reviewConfirmed} onClick={() => onApply(preview.draft!)}>Use full composition for final review</button> : <>
          <label className="flex gap-2 text-sm"><input type="checkbox" checked={approved} disabled={!ready || !preview.draft.reviewConfirmed} onChange={(e) => setApproved(e.target.checked)} />Replace the covered cells with these reviewed views and keep unseen historical stacks.</label>
          <button className="btn" disabled={!ready || !approved || !preview.draft.reviewConfirmed || !validDraft(preview.draft)} onClick={() => execute(async () => { if (stagedKey.current !== key.current) { await saveComposition(session.id, composition); stagedKey.current = key.current } const result = await commitPartial(session.id, session.baseRevision, key.current); if (alive.current) await onCommitted(result) })}>Commit visible-region update</button>
        </>}
      </>}
    </>}
  </section>
}

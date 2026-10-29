import { useMemo, useState } from 'react'
import { useItems } from '../api/hooks'
import { quantityFitsCatalog } from '../scan/quantity'
import { StackIdentityReview } from './StackIdentityReview'
import { JoinedSourceReview } from './JoinedSourceReview'
import { joinedShapeFits, validJoinedFacts } from './joinedFacts'
import type { FootprintJoin, JoinedSource, RegisteredView, ScanComposition, Stack } from './client'

const field = 'rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink'
type Part = FootprintJoin['parts'][number]
const partKey = (part: Part) => `${part.viewId}:${part.stackId}`

function fragmentSources(parts: Part[], views: RegisteredView[]): JoinedSource[] {
  return parts.flatMap((part) => {
    const view = views.find((entry) => entry.id === part.viewId)
    const stack = view?.draft.stacks.find((entry) => entry.id === part.stackId)
    if (!view || !stack) return []
    return [{ viewId: view.id, stackId: stack.id, screenshotHash: view.screenshotHash,
      viewColumn: view.column, viewRow: view.row, columns: view.columns, rows: view.rows, location: stack.location,
      sourceGrid: view.draft.observations.find((entry) => entry.id === stack.provenance.observationId)?.sourceGrid ?? null }]
  })
}

export function FootprintReconciliation({ composition, ready, onChange }: {
  composition: ScanComposition; ready: boolean; onChange: (next: ScanComposition) => void
}) {
  const catalog = useItems()
  const { views } = composition
  const [viewId, setViewId] = useState(views[0]?.id ?? '')
  const [query, setQuery] = useState('')
  const [selection, setSelection] = useState<{ views: RegisteredView[]; parts: Part[] }>({ views, parts: [] })
  const [editing, setEditing] = useState<string | null>(null)
  const parts = useMemo(() => selection.views === views ? selection.parts : [], [selection, views])
  const joins = composition.joins ?? []
  const used = useMemo(() => new Set((composition.joins ?? []).flatMap((join) => join.parts.map(partKey))), [composition.joins])
  const view = views.find((entry) => entry.id === viewId) ?? views[0]
  const candidates = useMemo(() => (view?.draft.stacks ?? []).filter((stack) => {
    const box = stack.location
    return !stack.joinedSources?.length && !used.has(partKey({ viewId: view!.id, stackId: stack.id }))
      && (box.column === 0 || box.row === 0 || box.column + box.width === view!.columns || box.row + box.height === view!.rows)
      && `${catalog.data?.items[stack.itemId ?? '']?.name ?? 'unknown'} ${box.column},${box.row}`.toLowerCase().includes(query.trim().toLowerCase())
  }), [view, used, query, catalog.data])
  const sources = useMemo(() => fragmentSources(parts, views), [parts, views])
  function create() {
    if (!ready || sources.length < 2 || joins.length >= 256) return
    const column = Math.min(...sources.map((source) => source.viewColumn + source.location.column))
    const row = Math.min(...sources.map((source) => source.viewRow + source.location.row))
    const right = Math.max(...sources.map((source) => source.viewColumn + source.location.column + source.location.width))
    const bottom = Math.max(...sources.map((source) => source.viewRow + source.location.row + source.location.height))
    const id = crypto.randomUUID()
    const output: Stack = { id, itemId: null, quantity: null, fir: 'unknown',
      location: { column, row, width: right - column, height: bottom - row, rotated: false },
      provenance: { identityConfirmed: false, quantityConfirmed: false, method: 'manual-join-review', screenshotHash: null, observationId: null, corrected: true },
      neverSell: sources.some((source) => views.find((entry) => entry.id === source.viewId)?.draft.stacks.find((stack) => stack.id === source.stackId)?.neverSell) }
    onChange({ ...composition, joins: [...joins, { id, parts: [...parts], output, samePhysicalItemConfirmed: false, reviewConfirmed: false }] })
    setSelection({ views, parts: [] }); setEditing(id)
  }
  function update(join: FootprintJoin) { onChange({ ...composition, joins: joins.map((entry) => entry.id === join.id ? join : entry) }) }
  return <details className="space-y-3 border-y border-line py-3">
    <summary className="cursor-pointer text-sm font-medium">Reconcile clipped items · {joins.length} joined footprints</summary>
    <p className="max-w-prose text-xs text-ink-muted">Select one boundary fragment per source view for a single physical item. The complete rectangle must be observed with no holes. If any source shows the whole item, use ordinary view authority instead. Check coverage and overlaps after editing; sources and counts are never matched automatically.</p>
    <fieldset disabled={!ready} className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <label className="grid gap-1 text-xs">Source view<select className={field} value={view?.id ?? ''} onChange={(event) => setViewId(event.target.value)}>
          {views.map((entry, index) => <option key={entry.id} value={entry.id}>View {index + 1} at {entry.column},{entry.row}</option>)}
        </select></label>
        <label className="grid gap-1 text-xs">Find a boundary fragment<input className={field} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Item name or local column,row" /></label>
      </div>
      <div className="flex max-h-40 flex-wrap gap-2 overflow-auto">
        {candidates.slice(0, 50).map((stack) => <button key={stack.id} className="btn text-xs" disabled={parts.some((part) => part.viewId === view!.id)} onClick={() => { setEditing(null); setSelection({ views, parts: [...parts, { viewId: view!.id, stackId: stack.id }] }) }}>
          {catalog.data?.items[stack.itemId ?? '']?.shortName ?? 'Unknown'} · {stack.location.column},{stack.location.row} · {stack.location.width}×{stack.location.height}
        </button>)}
      </div>
      <p className="text-xs text-ink-muted">{candidates.length} eligible fragments; first 50 shown. Refine the search when needed.</p>
      {parts.map((part, index) => <button key={partKey(part)} className="btn text-xs" onClick={() => setSelection({ views, parts: parts.filter((entry) => partKey(entry) !== partKey(part)) })}>Remove selected fragment {index + 1} from view {views.findIndex((entry) => entry.id === part.viewId) + 1}</button>)}
      {sources.length > 0 && <JoinedSourceReview sources={sources} />}
      <button className="btn" disabled={sources.length < 2 || joins.length >= 256} onClick={create}>Create unconfirmed joined footprint</button>
    </fieldset>
    {joins.map((join, index) => <div key={join.id} className="space-y-2 border-l-2 border-line pl-3">
      <div className="flex flex-wrap items-center gap-2 text-sm"><span>Joined item {index + 1}: {join.output.location.width}×{join.output.location.height} at {join.output.location.column},{join.output.location.row} · {join.parts.length} sources · {join.reviewConfirmed ? 'reviewed' : 'needs review'}</span>
        <button className="btn" disabled={!ready} onClick={() => { setSelection({ views, parts: [] }); setEditing(editing === join.id ? null : join.id) }}>Review joined item {index + 1}</button>
        <button className="btn" disabled={!ready} onClick={() => onChange({ ...composition, joins: joins.filter((entry) => entry.id !== join.id) })}>Remove joined item {index + 1}</button></div>
      {editing === join.id && <JoinEditor key={join.id} join={join} sources={fragmentSources(join.parts, views)} ready={ready} onChange={update} onClose={() => setEditing(null)} />}
    </div>)}
  </details>
}

function JoinEditor({ join, sources, ready, onChange, onClose }: { join: FootprintJoin; sources: JoinedSource[]; ready: boolean; onChange: (value: FootprintJoin) => void; onClose: () => void }) {
  const catalog = useItems()
  const output = join.output
  const item = catalog.data?.items[output.itemId ?? '']
  const amountValid = quantityFitsCatalog(output.quantity, item)
  const shapeValid = joinedShapeFits(output, catalog.data?.items)
  function patch(value: Partial<Stack>) {
    const next = { ...output, ...value }
    if ('itemId' in value && value.itemId !== output.itemId) {
      next.quantity = null; next.fir = 'unknown'; next.dogtag = undefined; next.durability = undefined
      next.provenance = { ...next.provenance, identityConfirmed: false, quantityConfirmed: false }
    } else if (value.provenance && !value.provenance.identityConfirmed) {
      if (next.dogtag) next.dogtag = { ...next.dogtag, confirmed: false }
      if (next.durability) next.durability = { ...next.durability, confirmed: false }
    }
    onChange({ ...join, output: next, reviewConfirmed: false })
  }
  return <fieldset disabled={!ready} className="space-y-3">
    <svg role="img" aria-label="Complete footprint outline and its source fragment rectangles; source coordinates are listed below"
      viewBox={`${output.location.column - 0.1} ${output.location.row - 0.1} ${output.location.width + 0.2} ${output.location.height + 0.2}`}
      className="max-h-32 w-full max-w-sm border border-line bg-surface">
      {sources.map((source, index) => <rect key={`${source.viewId}:${source.stackId}`} x={source.viewColumn + source.location.column} y={source.viewRow + source.location.row}
        width={source.location.width} height={source.location.height} className="fill-accent/15 stroke-ink-muted" strokeWidth={0.03} strokeDasharray={index % 2 ? '0.1 0.06' : undefined} />)}
      <rect x={output.location.column} y={output.location.row} width={output.location.width} height={output.location.height} fill="none" className="stroke-accent" strokeWidth={0.05} />
    </svg>
    <p className="text-xs text-ink-muted">Outline of the proposed complete rectangle and source fragments. Check coverage and overlaps to validate all intersections and cell authority.</p>
    <JoinedSourceReview sources={sources} />
    <StackIdentityReview stack={output} observation={undefined} items={catalog.data?.items} onChange={patch} onClose={onClose} onReadQuantity={async () => undefined} />
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={output.provenance.identityConfirmed} disabled={!output.itemId || !shapeValid} onChange={(event) => patch({ provenance: { ...output.provenance, identityConfirmed: event.target.checked } })} />Confirm complete item identity</label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={output.location.rotated} onChange={(event) => patch({ location: { ...output.location, rotated: event.target.checked }, provenance: { ...output.provenance, identityConfirmed: false, quantityConfirmed: false }, fir: 'unknown', dogtag: undefined, durability: undefined })} />Complete item is rotated</label>
    {!shapeValid && <p role="alert" className="text-sm text-danger">The complete rectangle differs from this item's catalog footprint. Check the orientation or leave identity unknown for manual review.</p>}
    <label className="grid gap-1 text-sm">Complete stack amount (blank means unknown)<input type="number" min={1} max={0xffff_ffff} step={1} className={`${field} w-32`} value={output.quantity ?? ''} onChange={(event) => {
      const quantity = event.target.value === '' ? null : event.target.valueAsNumber
      if (quantity === null || Number.isSafeInteger(quantity) && quantity > 0 && quantity <= 0xffff_ffff) patch({ quantity, provenance: { ...output.provenance, quantityConfirmed: false } })
    }} /></label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={output.provenance.quantityConfirmed} disabled={!amountValid} onChange={(event) => patch({ provenance: { ...output.provenance, quantityConfirmed: event.target.checked } })} />Confirm the complete amount; do not add fragment amounts together</label>
    <label className="grid gap-1 text-sm">Found in Raid<select className={`${field} w-40`} value={output.fir} onChange={(event) => patch({ fir: event.target.value as Stack['fir'] })}><option value="unknown">Unknown</option><option value="yes">Confirmed yes</option><option value="no">Confirmed no</option></select></label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={output.neverSell} onChange={(event) => patch({ neverSell: event.target.checked })} />Never sell this physical item (source protection is retained regardless)</label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={join.samePhysicalItemConfirmed} onChange={(event) => onChange({ ...join, samePhysicalItemConfirmed: event.target.checked, reviewConfirmed: false })} />These fragments show the same physical item in one unchanged container.</label>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={join.reviewConfirmed} disabled={!join.reviewConfirmed && (!join.samePhysicalItemConfirmed || !validJoinedFacts(output, catalog.data?.items))} onChange={(event) => onChange({ ...join, reviewConfirmed: event.target.checked })} />I reviewed all sources and the complete footprint's independent facts. Unknown facts stay unknown.</label>
  </fieldset>
}

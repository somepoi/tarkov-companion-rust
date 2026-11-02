import { useRef, useState } from 'react'
import { inventoryCall, type CommitResult, type Inventory } from './client'

/** Records a reported physical change; never infers a transfer from matching IDs. */
export function InvalidateContainersPanel({ inventory, disabled, run, onChanged }: {
  inventory: Inventory
  disabled: boolean
  run: <T>(work: () => Promise<T>) => Promise<T | undefined>
  onChanged: () => Promise<void>
}) {
  const [selected, setSelected] = useState<string[]>([])
  const [reason, setReason] = useState('Items moved between containers')
  const [message, setMessage] = useState('')
  const pending = useRef<{ fingerprint: string; key: string } | null>(null)
  const scanned = inventory.containers.filter(entry => entry.snapshot)
  return <fieldset disabled={disabled} className="space-y-3 rounded border border-line p-4">
    <legend className="px-1 font-semibold">Inventory changed in game?</legend>
    <p className="text-sm text-ink-muted">After moving items, select both the source and destination. Also mark containers affected by using, selling or rearranging items. Their saved facts stay in history and stop contributing to confirmed totals and allocations until a new full scan is reviewed. Unscanned containers already remain unknown.</p>
    <label className="block text-sm">What changed?
      <select className="ml-2 rounded border border-line bg-surface p-2" value={reason} onChange={event => { setReason(event.target.value); pending.current = null; setMessage('') }}>
        <option>Items moved between containers</option>
        <option>Items used, sold or removed</option>
        <option>Contents or layout changed</option>
      </select>
    </label>
    <div className="flex flex-wrap gap-3">
      {scanned.map(({ container }) => <label key={container.id} className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={selected.includes(container.id)} onChange={event => {
          setSelected(ids => event.target.checked ? [...ids, container.id] : ids.filter(id => id !== container.id))
          pending.current = null
          setMessage('')
        }} />{container.name}
      </label>)}
    </div>
    <button className="btn" disabled={!selected.length || selected.length > 256} onClick={() => void run(async () => {
      const expectedRevisions = Object.fromEntries(scanned.filter(entry => selected.includes(entry.container.id)).map(entry => [entry.container.id, entry.container.revision]))
      const payload = { profileId: inventory.profile.id, expectedRevisions, reason }
      const fingerprint = JSON.stringify(payload)
      if (pending.current?.fingerprint !== fingerprint) pending.current = { fingerprint, key: crypto.randomUUID() }
      const results = await inventoryCall<CommitResult[]>({ operation: 'invalidateInventory', request: { ...payload, idempotencyKey: pending.current.key } })
      setSelected([])
      setMessage(`${results.length} container(s) marked outdated. Take a new full scan of each affected container.`)
      await onChanged()
    })}>Mark selected containers outdated</button>
    {disabled && <p className="text-xs text-ink-dim">Wait for the current operation, or save or discard your scan draft before marking containers outdated.</p>}
    {!scanned.length && <p className="text-sm text-ink-muted">No saved scans to mark outdated.</p>}
    {message && <p role="status" className="text-sm">{message}</p>}
  </fieldset>
}

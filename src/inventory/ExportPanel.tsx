import { useEffect, useRef, useState } from 'react'
import { inventoryCall, type Inventory, type LocalProfile } from './client'
import ExportWorker from './export.worker?worker'
import { useProgressStore } from '../store/progress'

export function ExportPanel({ profile, busy, run }: { profile: LocalProfile; busy: boolean; run: (job: () => Promise<void>) => Promise<unknown> }) {
  const [message, setMessage] = useState('')
  const alive = useRef(true)
  const job = useRef<{ worker: Worker; reject: (error: Error) => void } | null>(null)
  const download = useRef<{ url: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const release = () => { if (download.current) { clearTimeout(download.current.timer); URL.revokeObjectURL(download.current.url); download.current = null } }
  useEffect(() => { alive.current = true; return () => { alive.current = false; release(); job.current?.worker.terminate(); job.current?.reject(new Error('Export cancelled after leaving this profile')); job.current = null } }, [])
  const save = (format: 'json' | 'csv') => { void run(async () => {
    const inventory = await inventoryCall<Inventory>({ operation: 'inventory', profileId: profile.id })
    if (!alive.current || useProgressStore.getState().gameMode !== profile.mode) return
    if (inventory.profile.id !== profile.id || inventory.profile.mode !== profile.mode) throw new Error('Inventory profile changed; retry the export')
    const at = new Date().toISOString()
    const blob = await new Promise<Blob>((resolve, reject) => {
      const worker = new ExportWorker()
      job.current = { worker, reject }
      const finish = () => { worker.terminate(); job.current = null }
      worker.onmessage = ({ data }: MessageEvent<{ blob?: Blob; error?: string }>) => {
        finish(); if (data.blob instanceof Blob && data.blob.size <= 20 * 1024 * 1024) resolve(data.blob); else reject(new Error(data.error ?? 'Inventory export did not return a bounded file'))
      }
      worker.onerror = () => { finish(); reject(new Error('Inventory export worker stopped')) }
      worker.onmessageerror = () => { finish(); reject(new Error('Inventory export worker returned an unreadable result')) }
      try { worker.postMessage({ inventory, format, at }) } catch (error) { finish(); reject(error) }
    })
    if (!alive.current || useProgressStore.getState().gameMode !== profile.mode) return
    release()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `tarkov-stash-${profile.mode}-${at.replaceAll(':', '-')}.${format}`
    try { document.body.append(link); link.click() } catch (error) { URL.revokeObjectURL(url); throw error } finally { link.remove() }
    download.current = { url, timer: setTimeout(release, 60000) }
    setMessage(`Download requested: ${inventory.containers.length} containers from ${profile.mode}. This report is not a recovery backup.`)
  }) }
  return <details className="border-y border-line py-3">
    <summary className="cursor-pointer text-sm font-medium">Export saved inventory facts</summary>
    <div className="mt-3 space-y-3">
      <p className="max-w-prose text-sm text-ink-muted">Export this profile’s saved containers, locations, unknown values and confirmation flags. Legacy counts are labeled separately. Drafts, images, prices and recommendations are excluded. Use Full backup for recovery with evidence.</p>
      <div className="flex flex-wrap gap-2"><button className="btn" disabled={busy} onClick={() => save('json')}>Download JSON</button><button className="btn" disabled={busy} onClick={() => save('csv')}>Download CSV</button></div>
      <p className="text-xs text-ink-muted">CSV neutralizes spreadsheet formulas in text; JSON preserves source text. Files are limited to 20 MiB.</p>
      {message && <p role="status" className="text-sm text-ink-muted">{message}</p>}
    </div>
  </details>
}

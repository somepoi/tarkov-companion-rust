import { useEffect, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type { CleanupResult } from '../shared/desktop-api'
import { formatDateTime } from '../lib/format'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

/** "Clean up now": first shows what would go, then removes it after a second click. */
export function CleanupPanel() {
  const [preview, setPreview] = useState<CleanupResult | null>(null)
  const [done, setDone] = useState<CleanupResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.desktop?.lastCleanup().then((r) => r && setDone(r)).catch((cause: unknown) => setError(String(cause)))
  }, [])

  const run = (dry: boolean) => {
    setBusy(true)
    setError(null)
    window.desktop
      ?.cleanUp(dry)
      .then((r) => {
        if (dry) setPreview(r)
        else {
          setPreview(null)
          setDone(r)
        }
      })
      .catch((e: unknown) => { setPreview(null); setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => setBusy(false))
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        {!preview && (
          <button type="button" className="btn" disabled={busy} onClick={() => run(true)}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Check what can go
          </button>
        )}
        {preview && preview.items.length > 0 && (
          <>
            <button type="button" className="btn border-accent text-accent" disabled={busy} onClick={() => run(false)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />} Remove {formatBytes(preview.bytes)}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          </>
        )}
        {preview && preview.items.length === 0 && <span className="text-ink-muted">No eligible leftovers found.</span>}
        {preview && <button type="button" className="btn" disabled={busy} onClick={() => run(true)}>Check again</button>}
        {error && <span className="text-red-400">{error}</span>}
      </div>
      {(preview ?? done)?.warnings?.length ? <ul role="status" className="space-y-1 text-ink-muted">{(preview ?? done)!.warnings!.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
      {preview && preview.items.length > 0 && (
        <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded border border-line bg-surface p-2 text-ink-muted">
          {preview.items.map((i) => (
            <li key={i.label} className="flex gap-2"><span className="min-w-0 flex-1 truncate" title={i.label}>{i.label}</span><span className="shrink-0 tabular-nums">{formatBytes(i.bytes)}</span></li>
          ))}
        </ul>
      )}
      {done && !preview && (
        <p className="text-ink-dim">
          {done.items.length ? `Removed ${formatBytes(done.bytes)} (${done.items.length} item${done.items.length === 1 ? '' : 's'})` : 'No files were removed'} · {formatDateTime(done.at)}
        </p>
      )}
    </div>
  )
}

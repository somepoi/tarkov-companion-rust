import { useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'

interface StagingResult {
  state: 'candidate' | 'none' | 'disabled'
  version?: string
  message?: string
}
/** Explicit staging builds only; never offers installation of unverified files. */
export function StagedUpdateCheck() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  if (!isTauri() || import.meta.env.VITE_STAGED_UPDATES !== '1') return null
  return <section className="space-y-2 border-t border-line pt-3">
    <h3 className="text-sm font-semibold">Update channel preview</h3>
    <p className="text-xs text-ink-muted">Checks the configured preview channel. No files are downloaded or installed.</p>
    <button className="btn text-xs" disabled={busy} onClick={async () => {
      setBusy(true)
      setMessage('')
      try {
        const result = await invoke<StagingResult>('check_staged_update')
        setMessage(result.state === 'candidate'
          ? `Version ${result.version} is listed. Its installer signature has not been verified; installation remains disabled.`
          : result.state === 'none' ? 'No newer version is listed.' : result.message ?? 'Preview channel is disabled.')
      } catch (cause) { setMessage(`Channel check failed: ${String(cause)}`) }
      finally { setBusy(false) }
    }}>{busy ? 'Checking…' : 'Check preview channel'}</button>
    {message && <p role="status" className="text-xs text-ink-muted">{message}</p>}
  </section>
}

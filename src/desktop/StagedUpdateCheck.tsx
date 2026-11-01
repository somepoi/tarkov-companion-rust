import { useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'

interface StagingResult {
  state: 'candidate' | 'none' | 'disabled' | 'verified'
  id?: string
  path?: string
  sha256?: string
  version?: string
  message?: string
}
/** Explicit staging builds only; never offers installation of unverified files. */
export function StagedUpdateCheck() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [candidate, setCandidate] = useState<StagingResult | null>(null)
  if (!isTauri() || import.meta.env.VITE_STAGED_UPDATES !== '1') return null
  return <section className="space-y-2 border-t border-line pt-3">
    <h3 className="text-sm font-semibold">Update channel preview</h3>
    <p className="text-xs text-ink-muted">Checks the configured preview channel. Downloading requires a separate click and verifies the signature and signed version. Installation remains disabled. Files are limited to 512 MiB and kept until you remove them.</p>
    <button className="btn text-xs" disabled={busy} onClick={async () => {
      setBusy(true)
      setMessage('')
      setCandidate(null)
      try {
        const result = await invoke<StagingResult>('check_staged_update')
        if (result.state === 'candidate') setCandidate(result)
        setMessage(result.state === 'candidate'
          ? `Version ${result.version} is listed. Its installer signature has not been verified; installation remains disabled.`
          : result.state === 'none' ? 'No newer version is listed.' : result.message ?? 'Preview channel is disabled.')
      } catch (cause) { setMessage(`Channel check failed: ${String(cause)}`) }
      finally { setBusy(false) }
    }}>{busy ? 'Checking…' : 'Check preview channel'}</button>
    {candidate?.id && <button className="btn text-xs" disabled={busy} onClick={async () => {
      setBusy(true)
      setMessage('Downloading and verifying the selected version…')
      try {
        const result = await invoke<StagingResult>('download_staged_update', { id: candidate.id })
        setMessage(`Version ${result.version} passed signature and signed-version verification. Saved at ${result.path}. SHA-256: ${result.sha256}. Installation remains disabled.`)
        setCandidate(null)
      } catch (cause) { setMessage(`Download or signature verification failed: ${String(cause)}`) }
      finally { setBusy(false) }
    }}>Download and verify {candidate.version}</button>}
    {message && <p role="status" className="break-words text-xs text-ink-muted">{message}</p>}
  </section>
}

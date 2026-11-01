import { useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'

interface StagingResult {
  state: 'candidate' | 'none' | 'disabled' | 'verified' | 'prepared'
  installEnabled?: boolean
  id?: string
  path?: string
  sha256?: string
  backup?: { path: string }
  version?: string
  message?: string
}
/** Explicit staging builds only; never offers installation of unverified files. */
export function StagedUpdateCheck() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [verified, setVerified] = useState<StagingResult | null>(null)
  const [savedDrafts, setSavedDrafts] = useState(false)
  const [candidate, setCandidate] = useState<StagingResult | null>(null)
  if (!isTauri() || import.meta.env.VITE_STAGED_UPDATES !== '1') return null
  return <section className="space-y-2 border-t border-line pt-3">
    <h3 className="text-sm font-semibold">Update channel preview</h3>
    <p className="text-xs text-ink-muted">Checks the configured preview channel. Downloading requires a separate click and verifies the signature and signed version. Installation is available only in explicitly enabled preview builds, after a fresh recovery copy. Files are limited to 512 MiB and kept until you remove them.</p>
    <button className="btn text-xs" disabled={busy} onClick={async () => {
      setBusy(true)
      setMessage('')
      setCandidate(null)
      setVerified(null)
      setSavedDrafts(false)
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
        setMessage(`Version ${result.version} passed signature and signed-version verification. Saved at ${result.path}. SHA-256: ${result.sha256}.${result.installEnabled ? " Installation requires a fresh recovery copy below." : " Installation remains disabled."}`)
        setCandidate(null)
        setVerified(result)
        setSavedDrafts(false)
      } catch (cause) { setMessage(`Download or signature verification failed: ${String(cause)}`) }
      finally { setBusy(false) }
    }}>Download and verify {candidate.version}</button>}
    {verified?.id && <div className="space-y-2">
      <label className="flex items-start gap-2 text-xs">
        <input type="checkbox" checked={savedDrafts} disabled={busy} onChange={(event) => setSavedDrafts(event.target.checked)} />
        I saved all open drafts and will keep the app idle while its recovery copy is created.
      </label>
      {!verified.installEnabled && <button className="btn text-xs" disabled={busy || !savedDrafts} onClick={async () => {
        setBusy(true)
        setMessage('Saving a full recovery copy. Native data changes are paused…')
        try {
          const { buildRendererBackup } = await import('../inventory/rendererBackup')
          const result = await invoke<StagingResult>('prepare_staged_update', {
            id: verified.id, rendererState: await buildRendererBackup(), savedDrafts,
          })
          setMessage(`Recovery copy saved at ${result.backup?.path}. Installation remains disabled. Save any further changes before preparing again.`)
          setVerified(null)
        } catch (cause) { setMessage(`Update preparation failed: ${String(cause)}`) }
        finally { setBusy(false) }
      }}>Save recovery copy before updating</button>}
      {verified.installEnabled && <button className="btn text-xs" disabled={busy || !savedDrafts} onClick={async () => {
        setBusy(true)
        setMessage('Verifying the staged file and saving a fresh recovery copy. The app will close when installation starts…')
        try {
          const { buildRendererBackup } = await import('../inventory/rendererBackup')
          await invoke('install_staged_update', {
            id: verified.id, sha256: verified.sha256, version: verified.version,
            rendererState: await buildRendererBackup(), savedDrafts,
          })
        } catch (cause) { setMessage(`Installation did not start: ${String(cause)}`) }
        finally { setBusy(false) }
      }}>Back up, close and install {verified.version}</button>}
    </div>}
    {message && <p role="status" className="break-words text-xs text-ink-muted">{message}</p>}
  </section>
}

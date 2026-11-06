import { CheckCircle2, FolderSearch, History, Loader2, ShieldCheck, XCircle } from 'lucide-react'
import { APP_NAME } from '../lib/app-info'
import { type Faction, useProfile, useProgressStore } from '../store/progress'
import { useLocalFlags } from './localFlags'
import { runBackfill, updateDesktopSettings, useDesktopStore } from './useDesktop'

const FACTIONS: Faction[] = ['USEC', 'BEAR']

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-surface">{n}</span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {children}
      </div>
    </section>
  )
}

/**
 * Shown once per progress store in the desktop app (see localFlags.ts). Everything here can be
 * changed later in Settings; nothing is required except pressing Done.
 */
export function FirstRunSetup() {
  const state = useDesktopStore((s) => s.state)
  const backfill = useDesktopStore((s) => s.backfill)
  const profile = useProfile()
  const gameMode = useProgressStore((s) => s.gameMode)
  const setGameMode = useProgressStore((s) => s.setGameMode)
  const setFaction = useProgressStore((s) => s.setFaction)
  const hasLogs = Boolean(state?.logsPath)
  const finish = () => {
    // These flags live next to the progress they describe (see localFlags.ts), so they are the
    // real "setup done" gate and are set even if the copy in settings.json cannot be saved.
    // If the user skipped "Read past logs", don't run it behind their back later either.
    useLocalFlags.getState().setBackfillDone(true)
    useLocalFlags.getState().setSetupDone(true)
    // Layout displays the shared settings error after the setup dialog closes.
    void updateDesktopSettings({ setupDone: true, initialBackfillDone: true }).catch(() => undefined)
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="setup-title" className="flex max-h-[92vh] w-full max-w-xl flex-col rounded-lg border border-line bg-surface-2 shadow-xl">
        <div className="border-b border-line px-5 py-3">
          <h2 id="setup-title" className="text-base font-semibold">Welcome to {APP_NAME}</h2>
          <p className="text-xs text-ink-muted">Three quick things, then you are set. Everything can be changed later under Settings.</p>
        </div>

        <div className="min-h-0 space-y-5 overflow-y-auto px-5 py-4">
          <Step n={1} title="Escape from Tarkov log files">
            <p className="text-xs text-ink-muted">
              Quest completions are picked up from the game's own log files while you play. The app only <em>reads</em> them; it never touches the game, its memory or its network traffic.
            </p>
            <div className="flex items-start gap-2 rounded border border-line bg-surface p-2 text-xs">
              {hasLogs ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />}
              <div className="min-w-0 flex-1">
                {hasLogs ? (
                  <>
                    <div className="font-medium">Logs folder found</div>
                    <code className="break-all text-ink-muted">{state?.logsPath}</code>
                  </>
                ) : (
                  <>
                    <div className="font-medium">Logs folder not found automatically</div>
                    <div className="text-ink-muted">
                      Pick it by hand: it is the <code>Logs</code> folder inside your game install (for the Steam version <code>…\Escape from Tarkov\build\Logs</code>). You can also do this later in Settings.
                    </div>
                  </>
                )}
              </div>
              <button type="button" onClick={() => void window.desktop?.pickLogsFolder()} className="btn shrink-0">
                <FolderSearch className="h-4 w-4" /> {hasLogs ? 'Change' : 'Choose folder'}
              </button>
            </div>
          </Step>

          <Step n={2} title="How do you play?">
            <div className="flex flex-wrap gap-4 text-sm">
              <div className="flex rounded border border-line bg-surface p-0.5" role="group" aria-label="Game mode">
                {(['pve', 'regular'] as const).map((m) => (
                  <button key={m} type="button" onClick={() => setGameMode(m)} aria-pressed={gameMode === m} className={`rounded px-3 py-1 font-semibold ${gameMode === m ? 'bg-accent text-surface' : 'text-ink-muted hover:text-ink'}`}>
                    {m === 'pve' ? 'PvE' : 'PvP'}
                  </button>
                ))}
              </div>
              <div className="flex rounded border border-line bg-surface p-0.5" role="group" aria-label="Faction">
                {FACTIONS.map((f) => (
                  <button key={f} type="button" onClick={() => setFaction(f)} aria-pressed={profile.faction === f} className={`rounded px-3 py-1 font-semibold ${profile.faction === f ? 'bg-accent text-surface' : 'text-ink-muted hover:text-ink'}`}>
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-ink-muted">Progress is kept separately for PvP and PvE, and the app switches automatically when the game logs show which mode you launched.</p>
          </Step>

          <Step n={3} title="Catch up on what you have already done">
            <p className="text-xs text-ink-muted">Reads your old game sessions and lists every quest you handed in to a trader. You check the list before anything is ticked.</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void runBackfill()} disabled={!hasLogs || backfill.running} className="btn">
                {backfill.running ? <Loader2 className="h-4 w-4 animate-spin" /> : <History className="h-4 w-4" />} Read past logs
              </button>
              {backfill.running && backfill.progress && (
                <span className="text-xs text-ink-muted">{backfill.progress.done} / {backfill.progress.total} sessions</span>
              )}
              {backfill.last && !backfill.running && (
                <span className="text-xs text-success">
                  Done: {backfill.last.found.pve} PvE and {backfill.last.found.regular} PvP quests found as completed.
                </span>
              )}
              {backfill.error && <span className="text-xs text-danger">{backfill.error}</span>}
            </div>
          </Step>

          <div className="flex items-start gap-2 rounded border border-line bg-surface p-2 text-xs text-ink-muted">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <span>
              Windows probably showed a SmartScreen warning when you ran the installer. That happens because this free app is not code-signed (signing certificates cost money). You will not see it again: updates download and install from inside the app.
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={finish} disabled={backfill.running} className="btn border-accent bg-accent text-surface hover:bg-accent">Done</button>
        </div>
      </div>
    </div>
  )
}

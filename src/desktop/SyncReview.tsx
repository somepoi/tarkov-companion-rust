import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { gameDataKeys } from '../api/hooks'
import type { GameData } from '../api/types'
import { History, Undo2, X } from 'lucide-react'
import { useGameData } from '../api/hooks'
import type { GameMode } from '../api/client'
import { formatDateTime, formatTimeAgo } from '../lib/format'
import { autoTickFor, useSyncHistory } from './syncHistory'
import { applyReview, dismissReview, useDesktopStore } from './useDesktop'

const MODE_LABEL: Record<GameMode, string> = { pve: 'PvE', regular: 'PvP' }
const dateText = (at: number) => (at ? formatDateTime(at) : 'unknown time')

/**
 * "Read past logs" result: every quest the logs show as handed in on your
 * current profile, for you to confirm. Nothing is ticked until you press Apply.
 */
export function SyncReviewDialog() {
  const review = useDesktopStore((s) => s.review)
  const gameData = useGameData()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<string> | null>(null)
  const keyOf = (mode: GameMode, taskId: string) => `${mode}:${taskId}`
  const initial = useMemo(() => new Set((review?.items ?? []).filter((i) => !i.previouslyUndone).map((i) => keyOf(i.mode, i.taskId))), [review])
  const [untick, setUntick] = useState<Set<string> | null>(null)
  const initialUntick = useMemo(() => new Set((review?.stale ?? []).map((i) => keyOf(i.mode, i.taskId))), [review])
  if (!review) return null
  const sel = selected ?? initial
  const toggle = (k: string) => {
    const next = new Set(sel)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setSelected(next)
  }
  // Names come from the data of the item's own mode (loaded before the review opens).
  const task = (id: string, mode?: GameMode) =>
    (mode ? queryClient.getQueryData<GameData>(gameDataKeys.mode(mode))?.tasksById[id] : undefined) ?? gameData.data?.tasksById[id]
  const modes = (['pve', 'regular'] as GameMode[]).filter((m) => review.items.some((i) => i.mode === m))
  const unt = untick ?? initialUntick
  const toggleUntick = (k: string) => {
    const next = new Set(unt)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setUntick(next)
  }
  const done = review.alreadyDone.pve + review.alreadyDone.regular

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="review-title" className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border border-line bg-surface-2 shadow-xl">
        <div className="flex items-start gap-2 border-b border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="review-title" className="text-base font-semibold">Check before ticking: quests handed in, according to your game logs</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              {review.items.length === 0
                ? 'Nothing new to tick.'
                : `${review.items.length} quest${review.items.length === 1 ? '' : 's'} were turned in to a trader on your current profile. Untick anything that looks wrong.`}{' '}
              Read {review.folders} game sessions.
              {done > 0 && ` ${done} already ticked in the app.`}
              {review.skippedOtherProfile > 0 && ` Ignored ${review.skippedOtherProfile} hand-ins from another profile (an older wipe or a second account).`}
              {!!review.unknownModeEvents && ` Excluded ${review.unknownModeEvents} quest events with unknown game mode. Review those quests manually.`}
            </p>
          </div>
          <button type="button" onClick={dismissReview} aria-label="Close without ticking" className="rounded p-1 text-ink-dim hover:bg-surface-3 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 text-sm">
          {review.stale.length > 0 && (
            <section className="mb-4 rounded border border-accent/50 bg-accent/5 p-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-accent">From before your profile reset · {review.stale.length}</h3>
              <p className="mb-1.5 text-[11px] text-ink-muted">
                These are ticked in the app, but you handed them in before your reset{(['pve', 'regular'] as GameMode[]).filter((m) => review.resetAt[m]).map((m) => ` (${MODE_LABEL[m]}: ${dateText(review.resetAt[m] as number)})`).join('')} and the game has made you start them again. Ticked ones below are unticked when you apply.
              </p>
              <ul className="divide-y divide-line rounded border border-line bg-surface">
                {review.stale.map((i) => {
                  const k = keyOf(i.mode, i.taskId)
                  const t = task(i.taskId, i.mode)
                  return (
                    <li key={k}>
                      <label className="flex items-center gap-2 px-2 py-1.5">
                        <input type="checkbox" checked={unt.has(k)} onChange={() => toggleUntick(k)} className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{t?.name ?? `Quest …${i.taskId.slice(-6)}`}</span>
                          <span className="block text-[11px] text-ink-dim">{MODE_LABEL[i.mode]} · handed in {dateText(i.at)}, before the reset · started again since</span>
                        </span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
          {modes.map((mode) => {
            const list = review.items.filter((i) => i.mode === mode)
            return (
              <section key={mode} className="mb-3">
                <div className="mb-1 flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{MODE_LABEL[mode]} · {list.length}</h3>
                  <button type="button" onClick={() => setSelected(new Set([...sel, ...list.map((i) => keyOf(mode, i.taskId))]))} className="ml-auto text-[11px] text-accent underline">all</button>
                  <button type="button" onClick={() => setSelected(new Set([...sel].filter((k) => !k.startsWith(`${mode}:`))))} className="text-[11px] text-accent underline">none</button>
                </div>
                <ul className="divide-y divide-line rounded border border-line bg-surface">
                  {list.map((i) => {
                    const k = keyOf(i.mode, i.taskId)
                    const t = task(i.taskId, i.mode)
                    return (
                      <li key={k}>
                        <label className="flex items-center gap-2 px-2 py-1.5">
                          <input type="checkbox" checked={sel.has(k)} onChange={() => toggle(k)} className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{t?.name ?? `Quest …${i.taskId.slice(-6)}`}</span>
                            <span className="block text-[11px] text-ink-dim">
                              {t?.trader.name ? `${t.trader.name} · ` : ''}handed in {dateText(i.at)}
                              {i.previouslyUndone && <span className="text-accent"> · you undid this before</span>}
                            </span>
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-5 py-3">
          <span className="mr-auto text-[11px] text-ink-dim">Every automatic tick can be undone later under Settings, Quest sync history.</span>
          <button type="button" onClick={dismissReview} className="btn">Skip</button>
          <button type="button" onClick={() => applyReview(review, sel, unt)} className="btn border-accent bg-accent text-surface hover:bg-accent">
            Tick {[...sel].filter((k) => review.items.some((i) => keyOf(i.mode, i.taskId) === k)).length} quests{unt.size > 0 && review.stale.length > 0 ? `, untick ${[...unt].filter((k) => review.stale.some((i) => keyOf(i.mode, i.taskId) === k)).length}` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Bottom-right note after a live tick from the game log, with Undo. */
export function SyncToast() {
  const toast = useSyncHistory((s) => s.toast)
  const undo = useSyncHistory((s) => s.undo)
  const dismiss = useSyncHistory((s) => s.dismissToast)
  const gameData = useGameData()
  if (!toast) return null
  const name = gameData.data?.tasksById[toast.taskId]?.name ?? 'Quest'
  return (
    <div role="status" className="fixed bottom-4 right-4 z-[65] flex max-w-sm items-center gap-3 rounded border border-success/50 bg-surface-2 px-3 py-2 text-sm shadow-lg">
      <span className="min-w-0 flex-1">
        <span className="font-medium">{name}</span> ticked from the game log ({MODE_LABEL[toast.mode]}).
      </span>
      <button type="button" onClick={() => undo(toast.id)} className="btn !px-2 !py-0.5 !text-xs"><Undo2 className="h-3.5 w-3.5" /> Undo</button>
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="text-ink-dim hover:text-ink"><X className="h-4 w-4" /></button>
    </div>
  )
}

/** Settings section: every automatic tick with its source line and Undo/Redo. */
export function SyncHistorySection() {
  const entries = useSyncHistory((s) => s.entries)
  const undo = useSyncHistory((s) => s.undo)
  const redo = useSyncHistory((s) => s.redo)
  const gameData = useGameData()
  const [showAll, setShowAll] = useState(false)
  const list = showAll ? entries : entries.slice(0, 15)
  return (
    <section className="space-y-1.5">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted"><History className="h-3.5 w-3.5" /> Quest sync history</h3>
      <p className="text-xs text-ink-muted">Quests ticked automatically from the game log. A quest is only ticked when the trader's hand-in message appears, never for single objectives. Undo removes the tick and stops that log line from ticking it again.</p>
      {entries.length === 0 ? (
        <p className="text-xs text-ink-dim">Nothing ticked automatically yet.</p>
      ) : (
        <ul className="max-h-64 space-y-0.5 overflow-y-auto rounded border border-line bg-surface p-1.5 text-xs">
          {list.map((e) => (
            <li key={e.id} className={`flex items-center gap-2 ${e.undone ? 'text-ink-dim line-through' : ''}`}>
              <span className="w-10 shrink-0 text-ink-dim">{MODE_LABEL[e.mode]}</span>
              <span className="min-w-0 flex-1 truncate" title={`${e.file}:${e.line}`}>{gameData.data?.tasksById[e.taskId]?.name ?? `Quest …${e.taskId.slice(-6)}`}</span>
              <span className="shrink-0 text-ink-dim">{e.source === 'live' ? 'live' : 'past logs'} · {formatTimeAgo(e.at || e.appliedAt)}</span>
              <button type="button" onClick={() => (e.undone ? redo(e.id) : undo(e.id))} className="shrink-0 underline hover:text-accent">{e.undone ? 'Redo' : 'Undo'}</button>
            </li>
          ))}
        </ul>
      )}
      {entries.length > 15 && (
        <button type="button" onClick={() => setShowAll((v) => !v)} className="text-xs text-accent underline">{showAll ? 'Show fewer' : `Show all ${entries.length}`}</button>
      )}
    </section>
  )
}

/** Small "from log" tag for a quest row; empty when the quest was ticked by hand. */
export function AutoTickBadge({ mode, taskId }: { mode: GameMode; taskId: string }) {
  const entry = useSyncHistory((s) => autoTickFor(s.entries, mode, taskId))
  if (!entry) return null
  return (
    <span title={`Ticked from the game log (${entry.source === 'live' ? 'live' : 'past logs'}), handed in ${dateText(entry.at)}. Undo under Settings if this is wrong.`} className="rounded border border-success/40 px-1 py-px text-[10px] uppercase tracking-wide text-success">
      from log
    </span>
  )
}

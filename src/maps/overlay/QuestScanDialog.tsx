import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, ImageUp, Loader2, ScanText, X } from 'lucide-react'
import type { Task } from '../../api/types'
import { StatusPill } from '../../components/Badges'
import { isDesktop } from '../../desktop/useDesktop'
import { formatDateTime } from '../../lib/format'
import type { TaskStatus } from '../../lib/taskStatus'
import { readWords, warmUpOcr } from '../../scan/ocr'
import { imageFromClipboard } from '../../scan/scanStore'
import { useMapOverlayStore } from '../../store/mapOverlay'
import { useProgressStore } from '../../store/progress'
import type { MapTask } from './mapTasks'
import { matchQuestNames, questNameIndex, type QuestNameMatch } from './questListMatch'

interface Shot {
  id: number
  label: string
  state: 'queued' | 'reading' | 'done' | 'error'
  found: number
  error?: string
}

/** Reads the screenshot twice (white text, then a cut-off picked from the picture) and keeps the best read per quest. */
async function readQuestNames(image: Blob, index: ReturnType<typeof questNameIndex>, isCurrent: () => boolean): Promise<QuestNameMatch[]> {
  const best = new Map<string, QuestNameMatch>()
  for (const threshold of [150, 'auto'] as const) {
    for (const m of matchQuestNames(await readWords(image, null, { threshold, isCurrent }), index)) {
      const prev = best.get(m.name)
      if (!prev || m.score > prev.score) best.set(m.name, m)
    }
  }
  return [...best.values()]
}

/**
 * Tick quests on the map from a screenshot of the in-game quest list. Quest names are
 * read offline (same reader as the stash scanner) and shown for review before anything
 * is ticked.
 */
export function QuestScanDialog({ mapName, mapTasks, allTasks, statuses, onClose }: { mapName: string; mapTasks: MapTask[]; allTasks: Task[]; statuses: Record<string, TaskStatus>; onClose: () => void }) {
  const setTasksChecked = useMapOverlayStore((s) => s.setTasksChecked)
  const onlyFound = useMapOverlayStore((s) => s.questScanOnlyFound)
  const setOnlyFound = useMapOverlayStore((s) => s.setQuestScanOnlyFound)
  const setTaskCompleted = useProgressStore((s) => s.setTaskCompleted)
  const [shots, setShots] = useState<Shot[]>([])
  const [found, setFound] = useState<Map<string, QuestNameMatch>>(new Map())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [gameShots, setGameShots] = useState<{ name: string; modified: number }[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const nextId = useRef(1)
  const active = useRef(true)
  const reads = useRef(Promise.resolve())
  const pending = useRef({ count: 0, bytes: 0 })
  const [queueError, setQueueError] = useState('')

  useEffect(() => {
    active.current = true
    return () => { active.current = false }
  }, [])

  const index = useMemo(() => questNameIndex(allTasks), [allTasks])
  const hereById = useMemo(() => new Map(mapTasks.map((m) => [m.task.id, m.task])), [mapTasks])
  const taskById = useMemo(() => new Map(allTasks.map((t) => [t.id, t])), [allTasks])

  const { here, elsewhere } = useMemo(() => {
    const here: { task: Task; read: string; score: number }[] = []
    const elsewhere: { name: string; where: string }[] = []
    for (const m of found.values()) {
      const ids = m.ids.filter((id) => hereById.has(id))
      if (ids.length) for (const id of ids) here.push({ task: hereById.get(id) as Task, read: m.read, score: m.score })
      else elsewhere.push({ name: m.name, where: taskById.get(m.ids[0])?.map?.name ?? 'no single map' })
    }
    here.sort((a, b) => a.task.name.localeCompare(b.task.name))
    return { here, elsewhere }
  }, [found, hereById, taskById])

  const read = useCallback(
    (image: Blob, label: string) => {
      if (!active.current) return
      if (!image.size || image.size > 64 * 1024 * 1024) {
        setQueueError(`${label}: image was not added. Choose a nonempty image no larger than 64 MiB.`)
        return
      }
      if (pending.current.count >= 64 || pending.current.bytes + image.size > 256 * 1024 * 1024) {
        setQueueError('Some images were not added because the quest queue limit was reached (64 images or 256 MiB). Wait for the current batch and add the remaining images again.')
        return
      }
      const id = nextId.current++
      const mode = useProgressStore.getState().gameMode
      const isCurrent = () => active.current && useProgressStore.getState().gameMode === mode
      pending.current.count++
      pending.current.bytes += image.size
      setShots((s) => [...s, { id, label, state: 'queued', found: 0 }])
      // Admit one image (both threshold passes) to the shared reader at a time.
      const job = reads.current.then(async () => {
        if (!isCurrent()) throw new Error('Image read was cancelled after closing or changing game mode. Add it again if needed.')
        setShots((s) => s.map((x) => x.id === id ? { ...x, state: 'reading' } : x))
        return readQuestNames(image, index, isCurrent)
      })
        .then((matches) => {
          if (!isCurrent()) throw new Error('Game mode changed during the image read. Add it again if needed.')
          setShots((s) => s.map((x) => (x.id === id ? { ...x, state: 'done', found: matches.length } : x)))
          setFound((prev) => {
            const next = new Map(prev)
            for (const m of matches) if (!next.has(m.name) || m.score > (next.get(m.name) as QuestNameMatch).score) next.set(m.name, m)
            return next
          })
          setSelected((prev) => {
            const next = new Set(prev)
            for (const m of matches) for (const tid of m.ids) if (hereById.has(tid)) next.add(tid)
            return next
          })
        })
        .catch((e: unknown) => {
          if (active.current) setShots((s) => s.map((x) => (x.id === id ? { ...x, state: 'error', error: e instanceof Error ? e.message : String(e) } : x)))
        })
        .finally(() => {
          pending.current.count--
          pending.current.bytes -= image.size
        })
      reads.current = job
    },
    [index, hereById],
  )

  useEffect(() => {
    warmUpOcr()
    if (isDesktop()) void window.desktop?.listGameScreenshots().then((value) => {
      if (active.current) setGameShots(value)
    }).catch(() => undefined)
    const onPaste = (e: ClipboardEvent) => {
      const img = imageFromClipboard(e)
      if (img) read(img, 'Pasted screenshot')
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKey)
    }
  }, [read, onClose])

  const reading = shots.some((s) => s.state === 'reading' || s.state === 'queued')
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  const apply = () => {
    const ticks = here.map((h) => h.task.id).filter((id) => selected.has(id))
    if (onlyFound) setTasksChecked(mapTasks.map((m) => m.task.id).filter((id) => !ticks.includes(id)), false)
    setTasksChecked(ticks, true)
    onClose()
  }
  const tickCount = here.filter((h) => selected.has(h.task.id)).length

  return (
    <div
      className="fixed inset-0 z-[75] flex items-center justify-center bg-black/80 p-2 sm:p-6"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        for (const f of Array.from(e.dataTransfer.files)) if (f.type.startsWith('image/')) read(f, f.name)
      }}
    >
      <div role="dialog" aria-modal="true" aria-labelledby="quest-scan-title" className="flex max-h-full w-full max-w-xl flex-col rounded-lg border border-line bg-surface-2 shadow-xl">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2">
          <ScanText className="h-5 w-5 text-accent" />
          <h2 id="quest-scan-title" className="text-base font-semibold">Scan quest list · {mapName}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto rounded p-1 text-ink-dim hover:bg-surface-3 hover:text-ink"><X className="h-5 w-5" /></button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
          <div className="rounded border-2 border-dashed border-line p-3 text-center text-ink-muted">
            <p>Paste a screenshot of your in-game quest list with <b>Ctrl+V</b>, drop one here, or</p>
            <button type="button" onClick={() => fileInput.current?.click()} className="btn mt-2 !py-1"><ImageUp className="h-4 w-4" /> Open image</button>
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => { for (const f of Array.from(e.target.files ?? [])) read(f, f.name); e.target.value = '' }} />
            <p className="mt-2 text-xs text-ink-dim">Character → Tasks (or a trader's Tasks tab). If the list scrolls, add one screenshot per page: results add up. Windows: Win+Shift+S copies a selection.</p>
            {gameShots.length > 0 && (
              <div className="mt-2 text-left">
                <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-muted"><FolderOpen className="h-3.5 w-3.5" /> Recent game screenshots</div>
                <ul className="space-y-0.5 text-xs">
                  {gameShots.slice(0, 5).map((s) => (
                    <li key={s.name}>
                      <button type="button" onClick={() => void window.desktop?.readGameScreenshot(s.name).then((b) => read(new Blob([b as BlobPart]), s.name))} className="w-full truncate rounded px-2 py-1 text-left hover:bg-surface-3">
                        {s.name} <span className="text-ink-dim">· {formatDateTime(s.modified)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {queueError && (
            <div role="alert" className="flex items-start gap-2 text-xs text-danger">
              <p className="min-w-0 flex-1 break-words">{queueError}</p>
              <button type="button" className="btn shrink-0" onClick={() => setQueueError('')}>Dismiss</button>
            </div>
          )}

          {shots.length > 0 && (
            <ul className="space-y-0.5 text-xs text-ink-muted">
              {shots.map((s) => (
                <li key={s.id} className="flex items-center gap-1.5">
                  {s.state === 'reading' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span className="min-w-0 truncate">{s.label}</span>
                  <span className={`shrink-0 ${s.state === 'error' ? 'text-red-400' : 'text-ink-dim'}`}>
                    · {s.state === 'queued' ? 'queued…' : s.state === 'reading' ? 'reading…' : s.state === 'error' ? `could not read it (${s.error})` : `${s.found} quest name${s.found === 1 ? '' : 's'} found`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {here.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">On {mapName} ({here.length})</h3>
              <ul className="space-y-1">
                {here.map((h) => (
                  <li key={h.task.id} className="flex items-start gap-2">
                    <input type="checkbox" checked={selected.has(h.task.id)} onChange={(e) => toggle(h.task.id, e.target.checked)} aria-label={`Show ${h.task.name} on the map`} className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-medium">{h.task.name}</span>
                        <span className="text-xs text-ink-muted">{h.task.trader.name}</span>
                        {statuses[h.task.id] && <StatusPill status={statuses[h.task.id]} />}
                      </div>
                      {h.score < 1 && <div className="text-[11px] text-ink-dim">Read as “{h.read}”</div>}
                      {statuses[h.task.id] === 'completed' && (
                        <div className="text-[11px] text-ink-dim">
                          Marked complete in the app, so the map unticks it again.{' '}
                          <button type="button" onClick={() => setTaskCompleted(h.task.id, false)} className="text-accent underline">Mark not complete</button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {elsewhere.length > 0 && (
            <section>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">Found, but not on {mapName} ({elsewhere.length})</h3>
              <ul className="space-y-0.5 text-xs text-ink-muted">
                {elsewhere.map((e) => (
                  <li key={e.name}>{e.name} <span className="text-ink-dim">· {e.where}</span></li>
                ))}
              </ul>
            </section>
          )}

          {shots.length > 0 && !reading && found.size === 0 && (
            <p className="text-xs text-ink-muted">No quest names were recognised. Try a sharper or larger screenshot of the list, with no quest hovered.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-2.5">
          <label className="flex items-center gap-2 text-xs" title="Off: the quests found are added to what is already ticked">
            <input type="checkbox" checked={onlyFound} onChange={(e) => setOnlyFound(e.target.checked)} className="h-4 w-4" />
            Only these (untick the other {mapName} quests)
          </label>
          <button type="button" onClick={apply} disabled={reading || (tickCount === 0 && !onlyFound) || here.length === 0} className="btn ml-auto border-accent bg-accent text-surface hover:bg-accent hover:text-surface">
            {onlyFound ? `Show only these ${tickCount}` : `Add ${tickCount} to the map`}
          </button>
        </div>
      </div>
    </div>
  )
}

export default QuestScanDialog

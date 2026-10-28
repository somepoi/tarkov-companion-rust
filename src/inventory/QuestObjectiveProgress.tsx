import { useMemo, useState } from 'react'
import type { GameMode } from '../api/client'
import type { Task, TaskObjective } from '../api/types'
import { consumesItems, objectiveAmount, objectiveDefinition, objectiveFactToken, orphanObjectiveProgress,
  remainingObjective, type ObjectiveProgressFact } from '../lib/objectiveProgress'
import { isFactionEligible } from '../lib/taskStatus'
import { useProgressStore, type Profile } from '../store/progress'

const inputClass = 'rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink'

export function QuestObjectiveProgress({ mode, tasks, profile, onRefresh, catalogReady }: {
  mode: GameMode; tasks: Task[]; profile: Profile; onRefresh: () => void; catalogReady: boolean
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState('')
  const matches = useMemo(() => tasks.filter((task) => !profile.completedTaskIds.has(task.id)
    && isFactionEligible(task, profile.faction) && task.objectives.some(consumesItems)
    && (search.trim() ? `${task.name} ${task.trader.name}`.toLowerCase().includes(search.trim().toLowerCase())
      : profile.activeTaskIds.has(task.id))).slice(0, 15), [tasks, profile, search])
  const task = tasks.find((entry) => entry.id === selected)
  const orphans = catalogReady ? orphanObjectiveProgress(tasks, profile) : []
  return (
    <details className="space-y-3 border-b border-line pb-3">
      <summary className="cursor-pointer text-sm font-medium">Partial quest hand-ins and placements</summary>
      <p className="max-w-prose text-sm text-ink-muted">
        Record amounts already handed in, placed or sold for an active quest. This changes remaining needs only.
        Update affected container scans after consuming items, then confirm inventory freshness again.
      </p>
      {profile.objectiveProgressReview !== undefined && (
        <p role="alert" className="text-sm text-warning">Saved partial progress could not be safely read or merged. Its original data remains in progress exports. Surplus advice is blocked until it is reviewed or cleared.</p>
      )}
      <label className="grid gap-1 text-xs text-ink-muted">
        Find an unfinished quest (active quests shown initially)
        <input className={`${inputClass} max-w-xl`} value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2">
        {matches.map((entry) => <button key={entry.id} className="btn text-xs" onClick={() => setSelected(entry.id)}>{entry.name}</button>)}
        {!matches.length && <p className="text-sm text-ink-muted">{catalogReady ? 'No matching active quests. Search by name or mark the quest active on the Quests page.' : 'Quest data is loading or unavailable. Saved counters are retained.'}</p>}
      </div>
      {task && (
        <section className="space-y-3" aria-label={`Partial progress for ${task.name}`}>
          <h3 className="font-medium">{task.name}</h3>
          <label className="flex gap-2 text-sm">
            <input type="checkbox" checked={profile.activeTaskIds.has(task.id)} disabled={profile.completedTaskIds.has(task.id)}
              onChange={(event) => useProgressStore.getState().setTaskActiveFor(mode, task.id, event.target.checked)} />
            I have this quest active in the game
          </label>
          {task.objectives.filter(consumesItems).map((objective) => (
            <ObjectiveCounter key={`${task.id}:${objective.id}`} mode={mode} task={task} objective={objective}
              profile={profile} fact={profile.objectiveProgress?.[task.id]?.[objective.id]} onRefresh={onRefresh} />
          ))}
        </section>
      )}
      {!!orphans.length && <p role="alert" className="text-sm text-warning">{orphans.length} saved objective counters no longer match a consuming catalog objective. Full requirements remain protected; review or clear the saved counters.</p>}
      {(Object.keys(profile.objectiveProgress ?? {}).length > 0 || profile.objectiveProgressReview !== undefined) && (
        <button className="btn" onClick={() => useProgressStore.getState().clearObjectiveProgressFor(mode)}>Clear all saved partial counters for this mode</button>
      )}
    </details>
  )
}

function ObjectiveCounter({ mode, task, objective, profile, fact, onRefresh }: {
  mode: GameMode; task: Task; objective: TaskObjective; profile: Profile;
  fact: ObjectiveProgressFact | undefined; onRefresh: () => void
}) {
  const [value, setValue] = useState(String(fact?.completed ?? 0))
  const [base, setBase] = useState(() => objectiveFactToken(fact))
  const [confirmation, setConfirmation] = useState<{ profile: Profile; signature: string } | null>(null)
  const [error, setError] = useState('')
  const definition = objectiveDefinition(task.id, objective)
  const total = objectiveAmount(objective.count) ? objective.count : null
  const completed = Number(value)
  const conflict = objectiveFactToken(fact) !== base
  const active = profile.activeTaskIds.has(task.id) && !profile.failedTaskIds.has(task.id) && !profile.completedTaskIds.has(task.id)
  const signature = JSON.stringify([definition, total, value, base, active])
  const confirmed = confirmation?.profile === profile && confirmation.signature === signature
  const supported = !!objective.planningDefinition && definition.length <= 8192 && !task.wiki
  const valid = value.trim() !== '' && objectiveAmount(completed) && total !== null && completed <= total
  const remaining = remainingObjective(profile, task, objective)
  function apply(remove = false) {
    setError('')
    try {
      const next: ObjectiveProgressFact | null = remove ? null : {
        completed, total: total as number, definition, confirmedAt: Date.now(), status: 'current',
      }
      useProgressStore.getState().setObjectiveProgressFor(mode, task.id, objective.id, next, base)
      setBase(objectiveFactToken(next ?? undefined))
      setConfirmation(null)
      if (remove) setValue('0')
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  return (
    <div className="space-y-2 border-t border-line pt-3">
      <p className="text-sm">{objective.description}</p>
      <p className="text-xs text-ink-muted">Required total: {total ?? 'unknown'} · remaining for planning: {remaining.quantity ?? 'unknown'}{fact && ` · saved amount: ${fact.completed} (${fact.status})`}</p>
      {remaining.gap && <p className="text-xs text-warning">{remaining.gap}</p>}
      {!supported && <p className="text-xs text-warning">A complete structured objective definition is required. <button className="text-accent underline" onClick={onRefresh}>Refresh quest data</button> or keep the full reserve.</p>}
      {conflict && <p role="alert" className="text-xs text-warning">Saved progress changed. <button className="btn" onClick={() => { setValue(String(fact?.completed ?? 0)); setBase(objectiveFactToken(fact)); setConfirmation(null) }}>Reload saved counter</button></p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs text-ink-muted">
          Already completed in game
          <input type="number" min={0} max={total ?? undefined} step={1} className={`${inputClass} w-28`}
            disabled={!active || !supported || conflict} value={value}
            onChange={(event) => { setValue(event.target.value); setConfirmation(null) }} />
        </label>
        <button className="btn" disabled={!active || !supported || !valid || !confirmed || conflict} onClick={() => apply()}>Save partial amount</button>
        {fact && <button className="btn" disabled={conflict} onClick={() => apply(true)}>Remove saved counter</button>}
      </div>
      <label className="flex gap-2 text-xs">
        <input type="checkbox" checked={confirmed} disabled={!active || !supported || !valid || conflict}
          onChange={(event) => setConfirmation(event.target.checked ? { profile, signature } : null)} />
        I checked this completed amount against the current game objective.
      </label>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  )
}

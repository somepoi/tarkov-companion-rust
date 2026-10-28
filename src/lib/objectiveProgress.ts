import type { Task, TaskObjective } from '../api/types'

export interface ObjectiveProgressFact {
  completed: number
  total: number
  definition: string
  confirmedAt: number
  status: 'current' | 'review'
}
export type ObjectiveProgress = Record<string, Record<string, ObjectiveProgressFact>>
export interface ObjectiveProgressContext {
  objectiveProgress?: ObjectiveProgress
  activeTaskIds: ReadonlySet<string>
  failedTaskIds: ReadonlySet<string>
  completedTaskIds: ReadonlySet<string>
}
const consume = new Set(['giveItem', 'plantItem', 'sellItem', 'mark'])
const blocked = new Set(['__proto__', 'constructor', 'prototype'])
export const progressKey = (value: string) => !!value && value.length <= 512 && !blocked.has(value)
export const objectiveAmount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
export const consumesItems = (objective: Pick<TaskObjective, 'type'>) => consume.has(objective.type)
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

/** Keep exact raw restrictions with stable object-key order, including fields not yet modeled. */
export function canonicalObjectiveDefinition(value: unknown): string {
  const sort = (entry: unknown, depth: number): unknown => {
    if (depth > 32) throw new Error('Quest objective definition is too deeply nested')
    if (Array.isArray(entry)) return entry.map((child) => sort(child, depth + 1))
    if (object(entry)) return Object.fromEntries(Object.keys(entry).sort().map((key) => [key, sort(entry[key], depth + 1)]))
    return entry
  }
  return JSON.stringify(sort(value, 0))
}

export function objectiveDefinition(taskId: string, objective: TaskObjective): string {
  return canonicalObjectiveDefinition({ taskId, raw: objective.planningDefinition ?? {
    id: objective.id, type: objective.type, count: objective.count, itemIds: [...objective.itemIds].sort(),
    markerItemId: objective.markerItemId, foundInRaid: objective.foundInRaid,
    optional: objective.optional, planningGaps: objective.planningGaps ?? [],
  } })
}

export function parseObjectiveProgress(value: unknown): ObjectiveProgress {
  if (value === undefined) return {}
  if (!object(value)) throw new Error('Partial objective progress must be an object')
  const parsed: ObjectiveProgress = {}
  let count = 0
  for (const [taskId, objectives] of Object.entries(value)) {
    if (!progressKey(taskId) || !object(objectives)) throw new Error('Invalid task in partial objective progress')
    const next: Record<string, ObjectiveProgressFact> = {}
    for (const [objectiveId, fact] of Object.entries(objectives)) {
      if (++count > 8192 || !progressKey(objectiveId) || !object(fact)
        || !objectiveAmount(fact.completed) || !objectiveAmount(fact.total) || fact.completed > fact.total
        || typeof fact.definition !== 'string' || !fact.definition || fact.definition.length > 8192
        || typeof fact.confirmedAt !== 'number' || !Number.isSafeInteger(fact.confirmedAt)
        || fact.confirmedAt < 0 || fact.confirmedAt > 8_640_000_000_000_000
        || (fact.status !== 'current' && fact.status !== 'review'))
        throw new Error('Invalid or excessive partial objective progress')
      next[objectiveId] = { completed: fact.completed, total: fact.total, definition: fact.definition,
        confirmedAt: fact.confirmedAt, status: fact.status }
    }
    if (Object.keys(next).length) parsed[taskId] = next
  }
  return parsed
}

export const objectiveFactToken = (fact: ObjectiveProgressFact | undefined) => JSON.stringify(fact ?? null)

/** Preserve the source counter but require explicit review after a lifecycle change. */
export function invalidateObjectiveProgress(facts: ObjectiveProgress | undefined, taskId: string): ObjectiveProgress {
  const existing = facts?.[taskId]
  if (!existing || !Object.values(existing).some((fact) => fact.status === 'current')) return facts ?? {}
  return { ...facts, [taskId]: Object.fromEntries(Object.entries(existing).map(([id, fact]) => [id, { ...fact, status: 'review' }])) }
}

export function remainingObjective(profile: ObjectiveProgressContext, task: Task, objective: TaskObjective) {
  const total = objectiveAmount(objective.count) ? objective.count : null
  const fact = profile.objectiveProgress?.[task.id]?.[objective.id]
  if (!fact) return { quantity: total, completed: 0, gap: undefined as string | undefined }
  if (!consumesItems(objective) || total === null || fact.total !== total || fact.definition !== objectiveDefinition(task.id, objective)
    || fact.status !== 'current' || !profile.activeTaskIds.has(task.id) || profile.failedTaskIds.has(task.id))
    return { quantity: total, completed: 0, gap: 'Saved partial objective progress needs review; full demand retained' }
  return { quantity: total - fact.completed, completed: fact.completed, gap: undefined as string | undefined }
}

export function orphanObjectiveProgress(tasks: Task[], profile: ObjectiveProgressContext) {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const orphaned: { taskId: string; objectiveId: string }[] = []
  for (const [taskId, entries] of Object.entries(profile.objectiveProgress ?? {})) {
    if (profile.completedTaskIds.has(taskId)) continue
    const task = byId.get(taskId)
    for (const objectiveId of Object.keys(entries))
      if (!task?.objectives.some((objective) => objective.id === objectiveId && consumesItems(objective)))
        orphaned.push({ taskId, objectiveId })
  }
  return orphaned
}

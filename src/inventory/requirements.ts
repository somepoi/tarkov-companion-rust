import type { HideoutStation, ItemsById, Task } from '../api/types'
import type { Profile } from '../store/progress'
import { isFactionEligible } from '../lib/taskStatus'
import type { PlanningPreferences, Requirement } from './client'
import { count, type RecipeCatalog } from './recipeCatalog'
import { consumesItems, orphanObjectiveProgress, remainingObjective } from '../lib/objectiveProgress'

interface Input {
  tasks: Task[]
  profile: Profile
  stations: HideoutStation[]
  stationLevels: Record<string, number>
  preferences: PlanningPreferences
  recipes: RecipeCatalog | undefined
  items: ItemsById
}

/** No inferred completion or aggregate collected counts are subtracted. They do
 * not prove an objective hand-in or identify a physical stack. */
export function buildRequirements(input: Input) {
  const requirements: Requirement[] = []
  const gaps: string[] = []
  const add = (r: Requirement) => {
    requirements.push(r)
    if (r.quantity === null || r.fir === 'unknown' || !r.alternatives.length)
      gaps.push(`${r.source}: unknown quantity, FIR or accepted items`)
    if (r.alternatives.some((id) => !input.items[id]))
      gaps.push(`${r.source}: item missing from the catalog`)
  }
  const consume = { kind: 'consume' } as const
  const reusable = (group: string) => ({ kind: 'reusable', group }) as const
  if (input.profile.objectiveProgressReview !== undefined)
    gaps.push('Saved partial objective data needs review; unrecognized source data is retained in progress exports')
  for (const entry of orphanObjectiveProgress(input.tasks, input.profile))
    gaps.push(`Saved objective ${entry.taskId}/${entry.objectiveId} is missing or no longer consumes items; review its counter`)
  for (const task of input.tasks) {
    if (
      input.profile.completedTaskIds.has(task.id) ||
      !isFactionEligible(task, input.profile.faction)
    )
      continue
    if (task.wiki)
      gaps.push(
        `${task.name}: wiki requirements contain unstructured conditions`,
      )
    for (const objective of task.objectives) {
      const progress = consumesItems(objective) ? remainingObjective(input.profile, task, objective) : undefined
      const source = `Quest: ${task.name} · ${objective.description}${progress?.completed ? ` (${progress.completed} already completed; ${progress.quantity} remaining)` : ''}`
      if (progress?.gap) gaps.push(`${source}: ${progress.gap}`)
      if (progress?.quantity === 0 && !progress.gap) continue
      if (objective.planningGaps?.length)
        gaps.push(...objective.planningGaps.map((g) => `${source}: ${g}`))
      if (['giveItem', 'plantItem', 'sellItem'].includes(objective.type)) {
        add({
          id: `quest:${task.id}:${objective.id}`,
          source,
          kind: consume,
          alternatives: objective.itemIds,
          quantity: progress?.quantity ?? count(objective.count),
          fir:
            objective.foundInRaid === true
              ? 'required'
              : objective.foundInRaid === false
                ? 'any'
                : 'unknown',
        })
      } else if (objective.type === 'mark') {
        add({
          id: `quest:${task.id}:${objective.id}`,
          source,
          kind: consume,
          alternatives: objective.markerItemId ? [objective.markerItemId] : [],
          quantity: progress?.quantity ?? count(objective.count),
          fir: 'any',
        })
      } else if (objective.type === 'buildWeapon') {
        gaps.push(
          `${source}: weapon condition and fitted parts require manual review`,
        )
        const ids = [
          objective.build?.weaponId,
          ...(objective.build?.partIds ?? []),
        ].filter((id): id is string => Boolean(id))
        for (const [i, id] of ids.entries())
          add({
            id: `quest:${task.id}:${objective.id}:${i}`,
            source,
            kind: consume,
            alternatives: [id],
            quantity: 1,
            fir: 'any',
          })
      } else if (objective.itemIds.length && objective.type !== 'findItem') {
        gaps.push(`${source}: unsupported item objective ${objective.type}`)
      }
    }
  }
  // A monotone dependency closure also adds all intermediate levels. No item is
  // released because a selected target omitted its prerequisite station.
  const byId = new Map(input.stations.map((s) => [s.id, s]))
  const targets = new Map(
    input.stations.map((s) => [
      s.id,
      input.preferences.hideoutTargets[s.id] ??
        Math.max(0, ...s.levels.map((l) => l.level)),
    ]),
  )
  let changed = true
  while (changed) {
    changed = false
    for (const [stationId, target] of targets) {
      const station = byId.get(stationId)
      if (!station) {
        gaps.push(`Missing hideout dependency ${stationId}`)
        continue
      }
      const current = input.stationLevels[stationId] ?? 0
      if (count(current) === null)
        gaps.push(`${station.name}: current level is invalid`)
      if (target > Math.max(0, ...station.levels.map((l) => l.level)))
        gaps.push(`${station.name}: target level is missing from catalog`)
      for (const level of station.levels.filter(
        (l) => l.level > current && l.level <= target,
      )) {
        for (const dep of level.stationLevelRequirements) {
          if (!byId.has(dep.stationId) || count(dep.level) === null) {
            gaps.push(`${station.name}: unknown dependency`)
            continue
          }
          if ((targets.get(dep.stationId) ?? 0) < dep.level) {
            targets.set(dep.stationId, dep.level)
            changed = true
          }
        }
      }
    }
  }
  for (const station of input.stations)
    for (const level of station.levels) {
      if (
        level.level <= (input.stationLevels[station.id] ?? 0) ||
        level.level > (targets.get(station.id) ?? 0)
      )
        continue
      level.itemRequirements.forEach((r, index) =>
        add({
          id: `hideout:${level.id}:${index}`,
          source: `Hideout: ${station.name} level ${level.level}`,
          kind: consume,
          alternatives: [r.itemId],
          quantity: count(r.count),
          fir:
            r.foundInRaid === true
              ? 'required'
              : r.foundInRaid === false
                ? 'any'
                : 'unknown',
        }),
      )
    }
  for (const [kind, selected] of [
    ['craft', input.preferences.craftBatches],
    ['barter', input.preferences.barterBatches],
  ] as const) {
    for (const [recipeId, batches] of Object.entries(selected)) {
      if (!batches) continue
      const recipe = input.recipes?.[
        kind === 'craft' ? 'crafts' : 'barters'
      ].find((r) => r.id === recipeId)
      if (!recipe) {
        gaps.push(`Selected ${kind} ${recipeId} is missing`)
        continue
      }
      const name = input.items[recipe.outputId]?.name ?? recipe.outputId
      if (
        kind === 'craft' &&
        recipe.stationId &&
        recipe.stationLevel !== null &&
        (input.stationLevels[recipe.stationId] ?? 0) < recipe.stationLevel
      )
        gaps.push(`Craft: ${name} requires a station level not yet built`)
      gaps.push(...recipe.gaps.map((g) => `${kind}: ${name} · ${g}`))
      recipe.inputs.forEach((r, index) =>
        add({
          id: `${kind}:${recipeId}:${index}`,
          source: `${kind === 'craft' ? 'Craft' : 'Barter'}: ${name} × ${batches}${r.tool ? ' (sequential tool)' : ''}`,
          kind: r.tool ? reusable(`craft-tool:${r.itemId}`) : consume,
          alternatives: [r.itemId],
          quantity:
            r.quantity === null
              ? null
              : count(r.quantity * (r.tool ? 1 : batches)),
          fir: 'any',
        }),
      )
    }
  }
  for (const id of Object.keys(input.preferences.hideoutTargets))
    if (!byId.has(id)) gaps.push(`Saved hideout target ${id} is missing`)
  return {
    requirements,
    coverageGaps: [...new Set(gaps)],
    effectiveHideoutTargets: Object.fromEntries(targets),
  }
}

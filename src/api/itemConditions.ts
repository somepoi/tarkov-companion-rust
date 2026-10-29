import type { TaskObjective } from './types'

/** Preserve malformed/partial state restrictions as gaps, never broad eligibility. */
export function objectiveItemConditions(raw: {
  dogTagLevel?: unknown; minDurability?: unknown; maxDurability?: unknown
}): Pick<TaskObjective, 'planningGaps' | 'minimumDogtagLevel' | 'durability'> {
  const planningGaps: string[] = []
  const integer = (value: unknown, maximum: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
  let minimumDogtagLevel: number | undefined
  if (raw.dogTagLevel != null) {
    if (!integer(raw.dogTagLevel, 1000)) planningGaps.push('Invalid dogtag level requires review')
    else if (raw.dogTagLevel > 0) minimumDogtagLevel = raw.dogTagLevel
  }
  let durability: TaskObjective['durability']
  if (raw.minDurability != null || raw.maxDurability != null) {
    if (!integer(raw.minDurability, 100) || !integer(raw.maxDurability, 100)
      || raw.minDurability > raw.maxDurability)
      planningGaps.push('Invalid or incomplete item durability range requires review')
    else if (raw.minDurability > 0 || raw.maxDurability < 100)
      durability = { minimum: raw.minDurability, maximum: raw.maxDurability }
  }
  return { planningGaps, minimumDogtagLevel, durability }
}

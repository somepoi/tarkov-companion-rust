import { fetchJson, type GameMode } from '../api/client'

export const RECIPE_PLANNING_SCHEMA = 2

/** Validated planning view of the JSON API. Never invent missing input counts. */
export interface Recipe {
  id: string
  outputId: string
  stationId: string | null
  stationLevel: number | null
  traderId?: string | null
  minimumTraderLevel?: number | null
  taskUnlock?: string | null
  inputs: { itemId: string; quantity: number | null; tool: boolean; minimumDogtagLevel?: number }[]
  gaps: string[]
}
export interface RecipeCatalog {
  /** Older offline adapters must not silently omit input restrictions. */
  planningSchema?: number
  crafts: Recipe[]
  barters: Recipe[]
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {}
const id = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 ? v : null
export const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 0xffffffff
    ? v
    : null

function parse(document: unknown, kind: 'craft' | 'barter'): Recipe[] {
  const data = record(document).data
  if (!Array.isArray(data) && (!data || typeof data !== 'object'))
    throw new Error(`Invalid ${kind} catalog`)
  const list = Array.isArray(data) ? data : Object.values(data as object)
  if (list.length > 10000)
    throw new Error(`${kind} catalog exceeds the supported size`)
  const ids = new Set<string>()
  return list.map((value) => {
    const raw = record(value)
    const recipeId = id(raw.id)
    const outputId = id(
      record(raw[kind === 'craft' ? 'productItem' : 'offeredItem']).item,
    )
    if (!recipeId || !outputId || ids.has(recipeId))
      throw new Error(`Invalid or duplicate ${kind} identifier`)
    ids.add(recipeId)
    const gaps: string[] = []
    const taskUnlock = raw.taskUnlock == null ? null : id(raw.taskUnlock)
    if (raw.taskUnlock != null && !taskUnlock) gaps.push('Invalid quest unlock condition')
    if (kind === 'barter' && !Object.hasOwn(raw, 'taskUnlock')) gaps.push('Quest unlock coverage is unknown')
    if (kind === 'craft' && (!Array.isArray(raw.gameEditions) || raw.gameEditions.length))
      gaps.push('Game edition access is unknown or restricted')
    const traderId = kind === 'barter' ? id(raw.trader) : null
    const minimumTraderLevel = kind === 'barter' ? count(raw.minTraderLevel) : null
    if (kind === 'barter' && (!traderId || minimumTraderLevel === null || minimumTraderLevel > 8))
      gaps.push('Trader loyalty requirement is unknown or unsupported')
    if (!Array.isArray(raw.requiredItems))
      throw new Error(`Missing ${kind} inputs`)
    const inputs = raw.requiredItems.map((v) => {
      const input = record(v)
      const itemId = id(input.item)
      if (!itemId) throw new Error(`Missing ${kind} input item`)
      const quantity = count(input.count)
      if (quantity === null) gaps.push('Unknown or fractional input quantity')
      const attributes = record(input.attributes)
      if (input.attributes != null && (typeof input.attributes !== 'object' || Array.isArray(input.attributes))) gaps.push('Malformed input attributes')
      const unsupported = Object.keys(attributes).filter(
        (k) => !((kind === 'craft' && k === 'tool') || (kind === 'barter' && k === 'minLevel')),
      )
      if (unsupported.length)
        gaps.push(`Unsupported input conditions: ${unsupported.join(', ')}`)
      if ('tool' in attributes && typeof attributes.tool !== 'boolean')
        gaps.push('Unknown tool condition')
      let minimumDogtagLevel: number | undefined
      if (kind === 'barter' && 'minLevel' in attributes) {
        const level = count(attributes.minLevel)
        if (level === null || level > 1000) gaps.push('Invalid minimum dogtag level')
        else if (level > 0) minimumDogtagLevel = level
      }
      return {
        itemId,
        quantity,
        tool: kind === 'craft' && attributes.tool === true,
        minimumDogtagLevel,
      }
    })
    if (
      kind === 'craft' &&
      Array.isArray(raw.requiredQuestItems) &&
      raw.requiredQuestItems.length
    )
      gaps.push('Quest-item craft inputs require review')
    if (kind === 'craft' && !Array.isArray(raw.requiredQuestItems))
      gaps.push('Quest-item input coverage is unknown')
    const stationId = kind === 'craft' ? id(raw.station) : null
    const stationLevel = kind === 'craft' ? count(raw.level) : null
    if (kind === 'craft' && (!stationId || stationLevel === null))
      gaps.push('Craft station requirement is unknown')
    // Duplicate tool entries in one recipe are simultaneous; sum them before
    // sharing the maximum tool reserve across sequential recipes.
    const tools = new Map<string, (typeof inputs)[number]>()
    for (const input of inputs.filter((r) => r.tool)) {
      const previous = tools.get(input.itemId)
      tools.set(input.itemId, {
        ...input,
        quantity: previous
          ? previous.quantity === null || input.quantity === null
            ? null
            : count(previous.quantity + input.quantity)
          : input.quantity,
      })
    }
    return {
      id: recipeId,
      outputId,
      inputs: [...inputs.filter((r) => !r.tool), ...tools.values()],
      stationId,
      stationLevel,
      traderId, minimumTraderLevel, taskUnlock,
      gaps,
    }
  })
}

export async function fetchRecipeCatalog(
  mode: GameMode,
  signal?: AbortSignal,
): Promise<RecipeCatalog> {
  const [crafts, barters] = await Promise.all([
    fetchJson<unknown>(`/${mode}/crafts`, signal),
    fetchJson<unknown>(`/${mode}/barters`, signal),
  ])
  return { planningSchema: RECIPE_PLANNING_SCHEMA, crafts: parse(crafts, 'craft'), barters: parse(barters, 'barter') }
}

import { friendlySwitchName } from './switchNames'
import { objectiveItemConditions } from './itemConditions'
import { adaptDogtagAlternatives, PLANNING_CATALOG_SCHEMA } from './planningItems'
import { feeRate } from '../lib/fleaFees'
import { canonicalObjectiveDefinition, consumesItems } from '../lib/objectiveProgress'
import { assertCatalogSupports, getEndpointCatalog } from './catalog'
import { fetchJson, type GameMode } from './client'
import { fetchTranslated, type Translator } from './translate'
import type {
  AmmoStats,
  Craft,
  FactionName,
  GameData,
  HideoutStation,
  RawCraftsDoc,
  RawHideoutStation,
  GameMap,
  Item,
  ItemsBundle,
  ItemsById,
  MapDetails,
  ModSlot,
  ModStats,
  PresetInfo,
  RawItem,
  RawItemSlot,
  WeaponStats,
  ObjectiveLocation,
  PricePoint,
  QuestItem,
  RawItemProperties,
  RawItemsData,
  RawMap,
  RawMapsData,
  RawPriceHistoryDoc,
  RawStatusDoc,
  RawTask,
  RawTaskObjective,
  RawTasksData,
  RawTrader,
  Task,
  TaskObjective,
  Trader,
  WeaponBuild,
} from './types'

// ---------------------------------------------------------------------------
// Adapters: raw document + translator -> app-facing objects
// ---------------------------------------------------------------------------

function adaptTrader(raw: RawTrader, t: Translator): Trader {
  const reset = raw.resetTime ? Date.parse(raw.resetTime) : NaN
  return {
    id: raw.id,
    name: t(raw.name, raw.normalizedName),
    normalizedName: raw.normalizedName,
    imageLink: raw.imageLink ?? null,
    currency: raw.currency ?? 'RUB',
    resetTime: Number.isFinite(reset) ? reset : null,
    maxLevel: Math.max(1, raw.levels?.length ?? 1),
    levels: (raw.levels ?? [])
      .filter((l) => l && typeof l.level === 'number')
      .map((l) => ({ level: l.level, playerLevel: l.requiredPlayerLevel ?? 0, reputation: l.requiredReputation ?? 0 }))
      .sort((a, b) => a.level - b.level),
  }
}

function adaptMaps(data: RawMapsData, t: Translator): GameMap[] {
  return Object.values(data.maps).map((m) => ({
    id: m.id,
    name: t(m.name, m.normalizedName),
    normalizedName: m.normalizedName,
    scenePath: m.scenePath ?? null,
    nameId: m.nameId,
    raidDuration: typeof m.raidDuration === 'number' ? m.raidDuration : 0,
  }))
}

const toFactionTag = (f: string): 'pmc' | 'scav' | 'shared' =>
  f === 'pmc' || f === 'scav' ? f : 'shared'

interface MobLookup {
  names: Record<string, string>
  normalized: Record<string, string>
}

function adaptMapDetails(m: RawMap, t: Translator, mobs: MobLookup): MapDetails {
  return {
    extracts: (m.extracts ?? []).map((e) => ({
      id: e.id,
      name: t(e.name, e.name),
      faction: toFactionTag(e.faction),
      position: e.position,
      outline: e.outline ?? [],
    })),
    transits: (m.transits ?? []).map((x) => ({
      id: x.id,
      name: t(x.description, 'Transit'),
      targetMapId: x.map ?? null,
      position: x.position,
      outline: x.outline ?? [],
    })),
    spawns: (m.spawns ?? []).map((s) => ({
      position: s.position,
      sides: s.sides ?? [],
      categories: s.categories ?? [],
      zoneName: s.zoneName ?? '',
    })),
    bosses: (m.bosses ?? []).map((b) => ({
      mobId: b.mob ?? null,
      name: (b.mob && mobs.names[b.mob]) || 'Boss',
      normalizedName: (b.mob && mobs.normalized[b.mob]) || b.mob || 'boss',
      spawnChance: b.spawnChance ?? 0,
      locations: (b.spawnLocations ?? []).map((l) => ({
        name: t(l.name, l.name),
        chance: l.chance ?? 0,
        positions: l.positions ?? [],
      })),
      escorts: (b.escorts ?? [])
        .filter((e) => e && e.mob)
        .map((e) => ({
          mobId: e.mob,
          name: mobs.names[e.mob] ?? e.mob,
          counts: [...new Set((e.amount ?? []).map((a) => a.count).filter((n) => typeof n === 'number' && n > 0))].sort((a, b) => a - b),
        })),
      spawnTime: typeof b.spawnTime === 'number' ? b.spawnTime : -1,
      spawnTimeRandom: Boolean(b.spawnTimeRandom),
      trigger: b.spawnTrigger ?? null,
    })),
    lootContainers: (m.lootContainers ?? []).map((c) => ({ containerId: c.lootContainer, position: c.position })),
    lootLoose: (m.lootLoose ?? [])
      .filter((l) => l && l.position)
      .map((l) => ({ position: l.position, itemIds: Array.isArray(l.items) ? l.items : [] })),
    locks: (m.locks ?? []).map((l) => ({
      id: l.id,
      lockType: l.lockType,
      keyId: l.key,
      needsPower: Boolean(l.needsPower),
      position: l.position,
    })),
    hazards: (m.hazards ?? []).map((h) => ({
      id: h.id,
      type: h.hazardType,
      name: t(h.name, h.hazardType),
      position: h.position,
      outline: h.outline ?? [],
    })),
    switches: (m.switches ?? [])
      .filter((s) => s && s.id && s.position)
      .map((s) => ({ id: s.id, name: t(s.name, friendlySwitchName(s.name ?? '')), switchType: s.switchType ?? '', position: s.position! })),
    stationaryWeapons: (m.stationaryWeapons ?? []).filter((w) => w && w.stationaryWeapon && w.position).map((w) => ({ itemId: w.stationaryWeapon!, position: w.position! })),
    btrStops: (m.btrStops ?? [])
      .filter((b) => b && typeof b.x === 'number' && typeof b.z === 'number')
      .map((b) => ({ name: t(b.name, 'BTR stop'), position: { x: b.x!, y: b.y ?? 0, z: b.z! } })),
  }
}

function adaptObjectiveLocations(raw: RawTaskObjective): ObjectiveLocation[] {
  const out: ObjectiveLocation[] = []
  for (const z of raw.zones ?? []) {
    if (!z?.map || !z.position) continue
    out.push({ mapId: z.map, positions: [z.position], outline: z.outline && z.outline.length > 2 ? z.outline : null, zoneId: z.id })
  }
  for (const p of raw.possibleLocations ?? []) {
    if (!p?.map || !p.positions?.length) continue
    out.push({ mapId: p.map, positions: p.positions, outline: null, zoneId: null })
  }
  return out
}

function adaptQuestItems(data: RawTasksData, t: Translator): Record<string, QuestItem> {
  const out: Record<string, QuestItem> = {}
  for (const q of Object.values(data.questItems ?? {})) {
    out[q.id] = {
      id: q.id,
      name: t(q.name, q.id),
      shortName: t(q.shortName, ''),
      iconLink: q.iconLink ?? null,
    }
  }
  return out
}

function adaptObjective(
  raw: RawTaskObjective,
  t: Translator,
  mapsById: Record<string, GameMap>,
  questItems: Record<string, QuestItem>,
): TaskObjective {
  const itemIds = raw.items && raw.items.length > 0 ? raw.items : raw.item ? [raw.item] : []
  return {
    id: raw.id,
    type: raw.type,
    planningDefinition: consumesItems(raw) ? canonicalObjectiveDefinition(raw) : undefined,
    description: t(raw.description, raw.type),
    optional: Boolean(raw.optional),
    maps: (raw.maps ?? []).map((id) => mapsById[id]).filter((m): m is GameMap => Boolean(m)),
    count: typeof raw.count === 'number' ? raw.count : null,
    ...objectiveItemConditions(raw),
    itemIds,
    questItem: raw.questItem ? (questItems[raw.questItem] ?? null) : null,
    foundInRaid: typeof raw.foundInRaid === 'boolean' ? raw.foundInRaid : null,
    targetNames: (raw.targetNames ?? []).map((n) => t(n, n)),
    locations: adaptObjectiveLocations(raw),
    requiredKeys: (raw.requiredKeys ?? []).map((g) => (Array.isArray(g) ? g : [g]).filter(Boolean)),
    exitName: raw.exitName ? t(raw.exitName, raw.exitName) : null,
    build: adaptBuild(raw),
    markerItemId: raw.markerItem ?? null,
    usingWeaponIds: (raw.usingWeapon ?? []).map(idOf).filter(Boolean),
    usingWeaponModIds: (raw.usingWeaponMods ?? []).map((g) => (Array.isArray(g) ? g : [g]).map(idOf).filter(Boolean)).filter((g) => g.length > 0),
    shotType: raw.shotType === 'kill' || raw.shotType === 'hit' ? raw.shotType : null,
    bodyParts: (raw.bodyParts ?? []).filter((p): p is string => typeof p === 'string'),
    distance: raw.distance && typeof raw.distance.value === 'number' && raw.distance.value > 0 ? { compare: raw.distance.compareMethod === '<=' ? '<=' : '>=', value: raw.distance.value } : null,
    hours: typeof raw.timeFromHour === 'number' && typeof raw.timeUntilHour === 'number' && raw.timeFromHour !== raw.timeUntilHour ? { from: raw.timeFromHour, until: raw.timeUntilHour } : null,
    wearingIds: (raw.wearing ?? []).map((g) => (Array.isArray(g) ? g : [g]).map(idOf).filter(Boolean)).filter((g) => g.length > 0),
  }
}

const idOf = (x: string | { id?: string } | null | undefined): string => (typeof x === 'string' ? x : (x?.id ?? ''))

function adaptBuild(raw: RawTaskObjective): WeaponBuild | null {
  if (raw.type !== 'buildWeapon') return null
  const limits: WeaponBuild['limits'] = []
  for (const [stat, v] of Object.entries(raw.buildAttributes ?? {})) {
    if (!v || typeof v.value !== 'number') continue
    const compare = v.compareMethod === '<=' ? '<=' : v.compareMethod === '=' || v.compareMethod === '==' ? '=' : '>='
    if (compare === '>=' && v.value === 0) continue // "at least 0" means no limit
    limits.push({ stat, compare, value: v.value })
  }
  return { weaponId: raw.item ?? null, partIds: raw.containsAll ?? [], categoryIds: raw.containsCategory ?? [], limits }
}

function toFaction(name: string): FactionName {
  return name === 'USEC' || name === 'BEAR' ? name : 'Any'
}

/** Turns trader/dialogue/story gates into short sentences for the detail panel. */
function describeOtherRequirements(raw: RawTask, tradersById: Record<string, Trader>): string[] {
  const traderName = (id: string) => tradersById[id]?.name ?? 'a trader'
  const out: string[] = []
  for (const r of raw.traderRequirements ?? []) {
    const cmp = r.compareMethod === '>=' ? '' : `${r.compareMethod} `
    if (r.requirementType === 'level') out.push(`${traderName(r.trader)} loyalty level ${cmp}${r.value}`)
    else if (r.requirementType === 'reputation') out.push(`${traderName(r.trader)} reputation ${cmp}${r.value}`)
    else out.push(`${traderName(r.trader)} ${r.requirementType} ${cmp}${r.value}`)
  }
  for (const r of raw.otherRequirements ?? []) {
    if (r.type === 'dialogue') {
      const names = (r.traders ?? []).map(traderName).join(', ')
      out.push(names ? `Talk to ${names}` : 'Trader dialogue')
    } else if (r.type === 'globalVariable') {
      out.push(`Story progression (stage ${r.compareMethod ?? '>='} ${r.value ?? '?'})`)
    } else {
      out.push(`Other: ${r.type}`)
    }
  }
  return out
}

function adaptTask(
  raw: RawTask,
  t: Translator,
  tradersById: Record<string, Trader>,
  mapsById: Record<string, GameMap>,
  questItems: Record<string, QuestItem>,
): Task {
  const trader = tradersById[raw.trader] ?? {
    id: raw.trader,
    name: 'Unknown trader',
    normalizedName: 'unknown',
    imageLink: null,
    currency: 'RUB',
    resetTime: null,
    maxLevel: 1,
    levels: [],
  }
  return {
    id: raw.id,
    name: t(raw.name, raw.normalizedName),
    normalizedName: raw.normalizedName,
    trader,
    map: raw.map ? (mapsById[raw.map] ?? null) : null,
    minPlayerLevel: raw.minPlayerLevel ?? 1,
    experience: raw.experience ?? 0,
    factionName: toFaction(raw.factionName),
    kappaRequired: Boolean(raw.kappaRequired),
    lightkeeperRequired: Boolean(raw.lightkeeperRequired),
    wikiLink: raw.wikiLink ?? null,
    taskImageLink: raw.taskImageLink ?? null,
    taskRequirements: (raw.taskRequirements ?? []).map((r) => ({
      taskId: r.task,
      status: r.status ?? [],
    })),
    otherRequirements: describeOtherRequirements(raw, tradersById),
    availableDelay: (raw.availableDelaySecondsMax ?? 0) > 0 ? { minS: raw.availableDelaySecondsMin ?? 0, maxS: raw.availableDelaySecondsMax ?? 0 } : null,
    storyGates: (raw.otherRequirements ?? [])
      .filter((r) => r.type === 'globalVariable' && r.variableId)
      .map((r) => ({ variableId: r.variableId as string, compare: r.compareMethod ?? '>=', value: r.value ?? 0 })),
    dialogueTraderIds: (raw.otherRequirements ?? []).filter((r) => r.type === 'dialogue').flatMap((r) => r.traders ?? []),
    neededKeys: (raw.neededKeys ?? [])
      .filter((k) => k && k.map && Array.isArray(k.keys))
      .map((k) => ({ mapId: k.map, keyIds: k.keys })),
    objectives: (raw.objectives ?? []).map((o) => adaptObjective(o, t, mapsById, questItems)),
    traderRequirements: (raw.traderRequirements ?? [])
      .filter((r) => r && r.trader && typeof r.value === 'number')
      .map((r) => ({ traderId: r.trader, type: r.requirementType, compare: r.compareMethod ?? '>=', value: r.value })),
    standing: (raw.finishRewards?.traderStanding ?? []).filter((s) => s && s.trader && typeof s.standing === 'number').map((s) => ({ traderId: s.trader, standing: s.standing })),
  }
}

function indexById<T extends { id: string }>(list: T[]): Record<string, T> {
  const out: Record<string, T> = {}
  for (const x of list) out[x.id] = x
  return out
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/** Tasks + traders + maps (with English names) for one game mode. */
export async function fetchGameData(gameMode: GameMode, signal?: AbortSignal): Promise<GameData> {
  // Read the catalog first so we fail with a clear message if the API changed.
  assertCatalogSupports(await getEndpointCatalog(), gameMode)

  const [tasksRes, tradersRes, mapsRes] = await Promise.all([
    fetchTranslated<RawTasksData>(gameMode, 'tasks', signal),
    fetchTranslated<Record<string, RawTrader>>(gameMode, 'traders', signal),
    fetchTranslated<RawMapsData>(gameMode, 'maps', signal),
  ])

  const traders = Object.values(tradersRes.doc.data).map((tr) => adaptTrader(tr, tradersRes.t))
  const maps = adaptMaps(mapsRes.doc.data, mapsRes.t).sort((a, b) => a.name.localeCompare(b.name))
  const tradersById = indexById(traders)
  const mapsById = indexById(maps)
  const questItems = adaptQuestItems(tasksRes.doc.data, tasksRes.t)

  const lootContainerNames: Record<string, string> = {}
  for (const c of Object.values(mapsRes.doc.data.lootContainers ?? {})) {
    lootContainerNames[c.id] = mapsRes.t(c.name, c.normalizedName)
  }
  const mobNames: Record<string, string> = {}
  const mobNormalized: Record<string, string> = {}
  const mobPortraits: Record<string, string> = {}
  for (const m of Object.values(mapsRes.doc.data.mobs ?? {})) {
    mobNames[m.id] = mapsRes.t(m.name, m.normalizedName)
    mobNormalized[m.id] = m.normalizedName
    if (m.imagePortraitLink) mobPortraits[m.id] = m.imagePortraitLink
  }
  const mapDetails: Record<string, MapDetails> = {}
  for (const rawMap of Object.values(mapsRes.doc.data.maps)) {
    mapDetails[rawMap.id] = adaptMapDetails(rawMap, mapsRes.t, { names: mobNames, normalized: mobNormalized })
  }
  dropPlaceholderTrunks(mapDetails)
  const latestGoon = (mapsRes.doc.data.goonReports ?? [])
    .map((g) => ({ mapId: g.map, at: Number(g.timestamp) }))
    .filter((g) => g.mapId && Number.isFinite(g.at))
    .sort((a, b) => b.at - a.at)[0]
  const goonReport = latestGoon ?? null

  const tasks = Object.values(tasksRes.doc.data.tasks).map((raw) =>
    adaptTask(raw, tasksRes.t, tradersById, mapsById, questItems),
  )

  return {
    gameMode,
    planningSchema: PLANNING_CATALOG_SCHEMA,
    tasks,
    tasksById: indexById(tasks),
    traders,
    maps,
    mapDetails,
    lootContainerNames,
    mobNames,
    mobPortraits,
    goonReport,
    fetchedAt: Date.now(),
  }
}

const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Ballistics for ammo rounds; null for anything else (grenades, ammo packs, gear). */
function adaptAmmo(p: RawItemProperties | null | undefined): AmmoStats | null {
  if (!p || p.propertiesType !== 'ItemPropertiesAmmo' || typeof p.caliber !== 'string' || !p.caliber) return null
  return {
    caliber: p.caliber,
    ammoType: p.ammoType ?? 'bullet',
    damage: num(p.damage),
    projectileCount: Math.max(1, num(p.projectileCount, 1)),
    penetrationPower: num(p.penetrationPower),
    armorDamage: num(p.armorDamage),
    fragmentationChance: num(p.fragmentationChance),
    ricochetChance: num(p.ricochetChance),
    initialSpeed: num(p.initialSpeed),
    tracer: p.tracer === true,
    tracerColor: p.tracer === true && p.tracerColor ? p.tracerColor : null,
    accuracyModifier: num(p.accuracyModifier),
    recoilModifier: num(p.recoilModifier),
    lightBleedModifier: num(p.lightBleedModifier),
    heavyBleedModifier: num(p.heavyBleedModifier),
  }
}

/** Weapon/part slots; revolver cylinder chambers (camora_*) hold rounds, not parts, and are dropped. */
function adaptSlots(slots: RawItemSlot[] | undefined): ModSlot[] {
  const out: ModSlot[] = []
  for (const s of slots ?? []) {
    if (!s || typeof s.id !== 'string' || typeof s.nameId !== 'string' || s.nameId.startsWith('camora')) continue
    const allowed = (s.filters?.allowedItems ?? []).filter((id) => typeof id === 'string')
    if (!allowed.length) continue
    out.push({ id: s.id, nameId: s.nameId, required: s.required === true, allowed })
  }
  return out
}

const MOD_PROPERTY_TYPES = new Set(['ItemPropertiesWeaponMod', 'ItemPropertiesScope', 'ItemPropertiesBarrel', 'ItemPropertiesMagazine'])

/** Weapon-builder data: base stats on firearms, modifiers on parts, part lists on presets. */
function adaptWeaponData(raw: RawItem, item: Item): void {
  const p = raw.properties
  if (!p) return
  const conflicts = (raw.conflictingItems ?? []).filter((id) => typeof id === 'string')
  if (p.propertiesType === 'ItemPropertiesWeapon' && raw.types?.includes('gun')) {
    const weapon: WeaponStats = {
      caliber: p.caliber ?? '',
      ergonomics: num(p.ergonomics),
      recoilVertical: num(p.recoilVertical),
      recoilHorizontal: num(p.recoilHorizontal),
      fireRate: num(p.fireRate),
      effectiveDistance: num(p.effectiveDistance),
      fireModes: Array.isArray(p.fireModes) ? p.fireModes : [],
      weight: num(raw.weight),
      slots: adaptSlots(p.slots),
      defaultPreset: p.defaultPreset ?? null,
      presets: Array.isArray(p.presets) ? p.presets : [],
      conflicts,
    }
    item.weapon = weapon
  } else if (p.propertiesType && MOD_PROPERTY_TYPES.has(p.propertiesType)) {
    const mod: ModStats = {
      ergonomics: num(p.ergonomics),
      recoilModifier: num(p.recoilModifier),
      accuracyModifier: num(p.accuracyModifier),
      weight: num(raw.weight),
      slots: adaptSlots(p.slots),
      conflicts,
    }
    item.mod = mod
  } else if (p.propertiesType === 'ItemPropertiesPreset' && typeof p.baseItem === 'string') {
    const base = p.baseItem
    const preset: PresetInfo = {
      baseItem: base,
      // Rounds loaded in the magazine are filtered out later (they are not parts).
      parts: (raw.containsItems ?? []).map((c) => c?.item).filter((id): id is string => typeof id === 'string' && id !== base),
      ergonomics: num(p.ergonomics),
      recoilVertical: num(p.recoilVertical),
      recoilHorizontal: num(p.recoilHorizontal),
      isDefault: p.default === true,
    }
    item.preset = preset
  }
  // Pictures for the Weapon builder's Modding view (only these items, to keep the cache small).
  if (item.weapon || item.mod || item.preset) {
    const grid = realPicture(raw.gridImageLink)
    const large = realPicture(raw.image512pxLink)
    if (grid) item.gridImageLink = grid
    if (large) item.image512Link = large
  }
}

/** tarkov.dev links items it has no picture for yet to a shared "unknown item" placeholder. */
function realPicture(link: string | null | undefined): string | null {
  return link && !link.includes('/unknown-item') ? link : null
}

/**
 * New colour variants of guns ("HK 416A5 … (RAL 8000)", "FN P90 … (Scourge)") often have no
 * pictures on tarkov.dev yet. Show the standard version's pictures instead (same gun, other
 * colour) and say so (`pictureOf`). Presets map the same way ("… (Scourge) Default").
 */
function borrowVariantPictures(out: ItemsById) {
  const byName = new Map<string, Item>()
  for (const it of Object.values(out)) byName.set(it.name, it)
  for (const it of Object.values(out)) {
    if (!(it.weapon || it.preset) || (it.iconLink && it.image512Link)) continue
    const plain = it.name.replace(/ \([^)]*\)(?=( Default)?$)/, '')
    const twin = plain !== it.name ? byName.get(plain) : undefined
    if (!twin?.iconLink) continue
    it.iconLink = it.iconLink ?? twin.iconLink
    it.gridImageLink = it.gridImageLink ?? twin.gridImageLink
    it.image512Link = it.image512Link ?? twin.image512Link
    it.pictureOf = twin.name
  }
}

/** All items (name, short name, icon, prices) plus the level XP table, for one game mode. ~1.4 MB compressed. */
export async function fetchItems(gameMode: GameMode, signal?: AbortSignal): Promise<ItemsBundle> {
  const { doc, t } = await fetchTranslated<RawItemsData>(gameMode, 'items', signal)
  const playerLevels = (doc.data.playerLevels ?? [])
    .filter((l) => typeof l.level === 'number' && typeof l.exp === 'number')
    .map((l) => ({ level: l.level, exp: l.exp }))
    .sort((a, b) => a.level - b.level)
  const out: ItemsById = {}
  for (const raw of Object.values(doc.data.items)) {
    const item: Item = {
      dogtagAlternatives: adaptDogtagAlternatives(raw, doc.data.items),
      id: raw.id,
      name: t(raw.name, raw.normalizedName),
      shortName: t(raw.shortName, raw.normalizedName),
      normalizedName: raw.normalizedName,
      iconLink: realPicture(raw.iconLink),
      wikiLink: raw.wikiLink ?? null,
      avg24hPrice: raw.avg24hPrice ?? null,
      fleaLevel: typeof raw.minLevelForFlea === 'number' && Number.isSafeInteger(raw.minLevelForFlea) && raw.minLevelForFlea >= 0 ? raw.minLevelForFlea : null,
      lastLowPrice: raw.lastLowPrice ?? null,
      low24hPrice: raw.low24hPrice ?? null,
      high24hPrice: raw.high24hPrice ?? null,
      changeLast48hPercent: raw.changeLast48hPercent ?? null,
      basePrice: raw.basePrice ?? 0,
      width: raw.width || 1,
      height: raw.height || 1,
      stackMaxSize: typeof raw.stackMaxSize === 'number' && Number.isSafeInteger(raw.stackMaxSize) && raw.stackMaxSize > 0 ? raw.stackMaxSize : null,
      types: raw.types ?? [],
      categories: raw.categories ?? [],
      sellToTrader: (raw.sellToTrader ?? [])
        .filter((s) => s && typeof s.priceRUB === 'number')
        .map((s) => ({ traderId: s.trader, priceRUB: s.priceRUB }))
        .sort((a, b) => b.priceRUB - a.priceRUB),
      buyFromTrader: (raw.buyFromTrader ?? [])
        .filter((s) => s && typeof s.priceRUB === 'number')
        .map((s) => ({
          traderId: s.trader,
          priceRUB: s.priceRUB,
          minTraderLevel: s.minTraderLevel,
          buyLimit: typeof s.buyLimit === 'number' ? s.buyLimit : undefined,
          taskUnlock: s.taskUnlock ?? null,
        }))
        .sort((a, b) => a.priceRUB - b.priceRUB),
      updated: raw.updated ?? null,
    }
    const ammo = adaptAmmo(raw.properties)
    if (ammo) item.ammo = ammo
    adaptWeaponData(raw, item)
    out[item.id] = item
  }
  borrowVariantPictures(out)
  const categoryNames: Record<string, string> = {}
  for (const [id, c] of Object.entries(doc.data.itemCategories ?? {})) {
    if (c?.name) categoryNames[c.id ?? id] = t(c.name, c.normalizedName ?? id)
  }
  const market = doc.data.fleaMarket
  return { planningSchema: PLANNING_CATALOG_SCHEMA, items: out, playerLevels, categoryNames, mode: gameMode, fetchedAt: Date.now(), fleaMarket: {
    enabled: typeof market?.enabled === 'boolean' ? market.enabled : null,
    minPlayerLevel: typeof market?.minPlayerLevel === 'number' && Number.isSafeInteger(market.minPlayerLevel) && market.minPlayerLevel >= 0 ? market.minPlayerLevel : null,
    foundInRaidRequired: typeof market?.foundInRaidRequired === 'boolean' ? market.foundInRaidRequired : null,
    sellOfferFeeRate: feeRate(market?.sellOfferFeeRate) ? market.sellOfferFeeRate : null,
    sellRequirementFeeRate: feeRate(market?.sellRequirementFeeRate) ? market.sellRequirementFeeRate : null,
  } }
}

/** Flea-market price history for one item (cached for 5 minutes by the hook). */
export async function fetchPriceHistory(
  gameMode: GameMode,
  itemId: string,
  signal?: AbortSignal,
): Promise<PricePoint[]> {
  const doc = await fetchJson<RawPriceHistoryDoc>(`/${gameMode}/prices/${itemId}`, signal)
  return doc.data ?? []
}

/** Hideout stations with every level's requirements and bonuses (names in English). */
export async function fetchHideout(gameMode: GameMode, signal?: AbortSignal): Promise<HideoutStation[]> {
  const { doc, t } = await fetchTranslated<Record<string, RawHideoutStation>>(gameMode, 'hideout', signal)
  return Object.values(doc.data)
    .filter((s) => s && Array.isArray(s.levels))
    .map((s) => ({
      id: s.id,
      name: t(s.name, s.normalizedName),
      normalizedName: s.normalizedName,
      imageLink: s.imageLink ?? null,
      levels: s.levels
        .map((l) => ({
          id: l.id,
          level: l.level,
          constructionTime: l.constructionTime ?? 0,
          traderRequirements: (l.traderRequirements ?? []).map((r) => ({ traderId: r.trader, level: r.value })),
          stationLevelRequirements: (l.stationLevelRequirements ?? []).map((r) => ({ stationId: r.station, level: r.level })),
          itemRequirements: (l.itemRequirements ?? [])
            .filter((r) => r && r.item)
            .map((r) => ({
              itemId: r.item,
              count: Number.isSafeInteger(r.count) && r.count >= 0 ? r.count : null,
              foundInRaid: typeof r.attributes?.foundInRaid === 'boolean' ? r.attributes.foundInRaid : null,
            })),
          skillRequirements: (l.skillRequirements ?? []).map((r) => ({ skill: t(r.skill, r.skill), level: r.level })),
          bonuses: (l.bonuses ?? []).map((b) => ({
            type: b.type,
            name: t(b.name, b.type),
            value: typeof b.value === 'number' ? b.value : null,
            skill: b.skill ? t(b.skill, b.skill) : null,
          })),
          description: t(l.description, ''),
        }))
        .sort((a, b) => a.level - b.level),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Hideout crafts (no translations needed; item/station names come from other documents). */
export async function fetchCrafts(gameMode: GameMode, signal?: AbortSignal): Promise<Craft[]> {
  const doc = await fetchJson<RawCraftsDoc>(`/${gameMode}/crafts`, signal)
  const list = Array.isArray(doc.data) ? doc.data : Object.values(doc.data ?? {})
  return list
    .filter((c) => c && c.productItem?.item)
    .map((c) => ({
      id: c.id,
      stationId: c.station,
      level: c.level ?? 1,
      duration: c.duration ?? 0,
      inputs: (c.requiredItems ?? [])
        .filter((r) => r && r.item)
        .map((r) => ({ itemId: r.item, count: r.count ?? 1, tool: Boolean(r.attributes?.tool) })),
      output: { itemId: c.productItem.item, count: c.productItem.count ?? 1 },
    }))
}

/** EFT server status. */
export async function fetchServerStatus(signal?: AbortSignal): Promise<RawStatusDoc['data']> {
  const doc = await fetchJson<RawStatusDoc>('/status', signal)
  return doc.data
}

/**
 * Car trunks in the game files carry a placeholder key: the Factory emergency exit key "opens"
 * 19 trunks across Lighthouse, Streets, Shoreline and Ground Zero, a cottage safe key 6. Real
 * car keys open one or two trunks. Trunk locks of a key with more than this many are dropped.
 */
const MAX_REAL_TRUNKS = 3
function dropPlaceholderTrunks(mapDetails: Record<string, MapDetails>) {
  const trunks = new Map<string, number>()
  for (const d of Object.values(mapDetails)) for (const l of d.locks) if (l.lockType === 'trunk') trunks.set(l.keyId, (trunks.get(l.keyId) ?? 0) + 1)
  for (const d of Object.values(mapDetails)) d.locks = d.locks.filter((l) => l.lockType !== 'trunk' || (trunks.get(l.keyId) ?? 0) <= MAX_REAL_TRUNKS)
}

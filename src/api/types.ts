/**
 * Types for the tarkov.dev JSON API.
 *
 * "Raw*" types mirror the documents exactly as downloaded on 2026-10-02 from
 * https://json.tarkov.dev/regular/{tasks,items,traders,maps}. Only the fields
 * this app reads are listed; the real documents contain many more.
 *
 * The un-prefixed types (Task, Item, Trader, GameMap ...) are the app-facing
 * shapes after English translations have been merged in and id references
 * have been resolved to objects.
 */

import type { GameMode } from './client'

/** In-game position; y is height. */
export interface Position {
  x: number
  y: number
  z: number
}

// ---------------------------------------------------------------------------
// Catalog: GET /endpoints
// ---------------------------------------------------------------------------

export interface CatalogEndpoint {
  name: string
  /** e.g. "/{{gameMode}}/tasks" */
  path: string
  description: string
  translations: boolean
}

export interface EndpointCatalog {
  data: {
    endpoints: CatalogEndpoint[]
    gameModes: string[]
    languages: string[]
  }
}

// ---------------------------------------------------------------------------
// Translation documents: GET /{gameMode}/{endpoint}_{lang}
// A flat dictionary: translation key -> localized string.
// ---------------------------------------------------------------------------

export type TranslationDict = Record<string, string>

export interface TranslationDoc {
  data: TranslationDict
}

/** Base documents carry a list of JSONPath expressions naming translated fields. */
export interface TranslatedBaseDoc<TData> {
  data: TData
  translations?: string[]
}

// ---------------------------------------------------------------------------
// Tasks: GET /{gameMode}/tasks   -> data.tasks is keyed by task id
// ---------------------------------------------------------------------------

export interface RawTaskRequirement {
  /** Prerequisite task id. */
  task: string
  /** Required state(s) of that task: "complete" | "active" | "failed". */
  status: string[]
}

export interface RawTraderRequirement {
  id: string
  /** "level" (loyalty level) | "reputation" */
  requirementType: string
  compareMethod: string
  value: number
  trader: string
}

/**
 * Non-task gates observed in the data: "dialogue" (talk to a trader) and
 * "globalVariable" (story progression). Neither can be tracked by this app.
 */
export interface RawOtherRequirement {
  id: string
  type: string
  traders?: string[]
  variableId?: string
  compareMethod?: string
  value?: number
}

export interface RawZone {
  id: string
  /** Map id. */
  map: string
  position: Position
  outline?: Position[]
  top?: number
  bottom?: number
}

export interface RawPossibleLocation {
  /** Map id. */
  map: string
  positions: Position[]
}

export interface RawTaskObjective {
  id: string
  /** Translation key (equals the objective id). */
  description: string
  /** visit | giveItem | shoot | extract | findQuestItem | giveQuestItem | findItem | plantItem | mark | ... */
  type: string
  optional: boolean
  /** Map ids this objective can be done on (empty = anywhere). */
  maps?: string[]
  /** Visit/plant/mark zones with a centre and an outline polygon. */
  zones?: RawZone[]
  /** Item spawn points (findItem / findQuestItem). */
  possibleLocations?: RawPossibleLocation[]
  /** Key item ids needed to reach the objective: groups of alternatives, all groups required. */
  requiredKeys?: string[][]
  /** Extract objectives: translation key of the extract name. */
  exitName?: string
  exitStatus?: string[]
  // Item objectives (giveItem / findItem / plantItem / sellItem ...)
  count?: number
  /** Accepted item ids (any one of them satisfies the objective). */
  items?: string[]
  /** Single item id on some objective kinds. */
  item?: string
  foundInRaid?: boolean
  dogTagLevel?: number
  minDurability?: number
  maxDurability?: number
  // Quest-item objectives reference data.questItems
  questItem?: string
  /** mark objectives: the marker to place (MS2000 etc.). */
  markerItem?: string
  /** shoot objectives: weapons that count (ids, or {id} objects). */
  usingWeapon?: (string | { id?: string })[]
  /** shoot objectives: alternative outfits; each outfit = items worn together. */
  wearing?: (string | { id?: string })[][]
  // buildWeapon objectives (Gunsmith): base weapon in `item`, parts that must be fitted,
  // part categories that must be present, and stat limits.
  containsAll?: string[]
  containsCategory?: string[]
  buildAttributes?: Record<string, { value: number; compareMethod: string }>
  // Shoot objectives
  targetNames?: string[]
  shotType?: string
  /** "QuestCondition/Elimination/Kill/BodyPart/Head" etc.; empty = any part. */
  bodyParts?: string[]
  /** Parts the weapon must carry: each set must be fitted whole; the sets are alternatives. */
  usingWeaponMods?: (string | { id?: string })[][]
  distance?: { compareMethod?: string; value?: number } | null
  timeFromHour?: number
  timeUntilHour?: number
  // Task-status objectives
  task?: string
  status?: string[]
  // Trader-level objectives
  trader?: string
  level?: number
}

export interface RawTask {
  id: string
  /** Translation key, e.g. "657315ddab5a49b71f098853 name". */
  name: string
  normalizedName: string
  /** Trader id. */
  trader: string
  /** Map id; absent/null when the task is not tied to one map. */
  map?: string | null
  wikiLink: string | null
  taskImageLink?: string | null
  minPlayerLevel: number
  experience: number
  /** "Any" | "USEC" | "BEAR" */
  factionName: string
  kappaRequired: boolean
  lightkeeperRequired: boolean
  restartable: boolean
  taskRequirements: RawTaskRequirement[]
  traderRequirements: RawTraderRequirement[]
  otherRequirements?: RawOtherRequirement[]
  objectives: RawTaskObjective[]
  /** Keys the task needs per map: { map: map id, keys: [item ids] }. */
  neededKeys?: { map: string; keys: string[] }[]
  availableDelaySecondsMin?: number
  availableDelaySecondsMax?: number
  /** Present on some tasks, e.g. ["regular"]. */
  gameMode?: string[]
  /** Prestige id when the task needs a prestige level. */
  requiredPrestige?: string
  /** Reputation changes when the quest is handed in (and, in the data, none when it fails). */
  finishRewards?: { traderStanding?: { trader: string; standing: number }[] }
}

export interface RawQuestItem {
  id: string
  /** Translation keys ("<id> Name", "<id> ShortName", "<id> Description"). */
  name: string
  shortName: string
  description: string
  iconLink: string | null
  gridImageLink?: string | null
  width: number
  height: number
}

export interface RawTasksData {
  tasks: Record<string, RawTask>
  questItems: Record<string, RawQuestItem>
  achievements?: Record<string, unknown>
  prestige?: unknown[]
}

export type RawTasksDoc = TranslatedBaseDoc<RawTasksData>

// ---------------------------------------------------------------------------
// Traders: GET /{gameMode}/traders   -> data is keyed by trader id (no wrapper)
// ---------------------------------------------------------------------------

export interface RawTrader {
  id: string
  /** Translation key, e.g. "54cb50c76803fa8b248b4571 Nickname". */
  name: string
  normalizedName: string
  description: string
  currency: string
  imageLink: string | null
  /** ISO timestamp of the next restock (observed 40 min .. 3 h ahead). */
  resetTime?: string | null
  levels?: { level: number; requiredPlayerLevel?: number; requiredReputation?: number; requiredCommerce?: number }[]
}

export type RawTradersDoc = TranslatedBaseDoc<Record<string, RawTrader>>

// ---------------------------------------------------------------------------
// Maps: GET /{gameMode}/maps   -> data.maps is keyed by map id
// ---------------------------------------------------------------------------

export interface RawExtract {
  id: string
  /** Translation key. */
  name: string
  /** "pmc" | "scav" | "shared" */
  faction: string
  position: Position
  outline?: Position[]
  top?: number
  bottom?: number
  switch?: string | null
}

export interface RawTransit {
  id: string
  /** Translation key, e.g. "CUS_TRANSIT_9_DESC". */
  description: string
  /** Destination map id. */
  map: string
  position: Position
  outline?: Position[]
}

export interface RawSpawn {
  position: Position
  /** "pmc" | "scav" | "none" */
  sides: string[]
  /** "player" | "bot" | "botpmc" | "boss" ... */
  categories: string[]
  zoneName: string
}

export interface RawBossSpawn {
  spawnChance: number
  spawnLocations: { name: string; chance: number; spawnKey?: string; positions: Position[] }[]
  /** Mob id (data.mobs). */
  mob?: string
  escorts?: { mob: string; amount?: { chance: number; count: number }[] }[]
  spawnTime?: number
  spawnTimeRandom?: boolean
  spawnTrigger?: string | null
}

export interface RawLootContainerSpawn {
  /** Container id (data.lootContainers). */
  lootContainer: string
  position: Position
}

export interface RawLock {
  id: string
  /** "door" | "container" | "trunk" ... */
  lockType: string
  /** Key item id. */
  key: string
  needsPower: boolean
  position: Position
}

export interface RawHazard {
  id: string
  hazardType: string
  /** Translation key or raw name. */
  name: string
  position: Position
  outline?: Position[]
}

export interface RawMap {
  id: string
  /** Translation key, e.g. "55f2d3fd4bdc2d5f408b4567 Name". */
  name: string
  normalizedName: string
  nameId: string
  /** Unity scene bundle, e.g. "maps/shopping_mall.bundle"; appears in the game log when a raid loads. */
  scenePath?: string
  players: string
  raidDuration: number
  wiki?: string | null
  minPlayerLevel?: number
  maxPlayerLevel?: number
  extracts?: RawExtract[]
  transits?: RawTransit[]
  spawns?: RawSpawn[]
  bosses?: RawBossSpawn[]
  lootContainers?: RawLootContainerSpawn[]
  /** Loose loot spawn points with the item ids that can appear there. */
  lootLoose?: { position: Position; items: string[] }[]
  locks?: RawLock[]
  hazards?: RawHazard[]
  /** Levers, power switches, elevator and alarm buttons. */
  switches?: { id: string; name?: string; switchType?: string; position?: Position; activates?: unknown[] }[]
  /** Mounted machine guns and grenade launchers (item id of the weapon). */
  stationaryWeapons?: { stationaryWeapon?: string; position?: Position }[]
  /** BTR taxi stops (Woods, Streets): a translation key and the spot. */
  btrStops?: { name?: string; x?: number; y?: number; z?: number }[]
}

export interface RawMapsData {
  maps: Record<string, RawMap>
  /** Loot container definitions (name is a translation key). */
  lootContainers?: Record<string, { id: string; name: string; normalizedName: string }>
  /** Boss/mob definitions (name is a translation key). */
  mobs?: Record<string, { id: string; name: string; normalizedName: string; imagePortraitLink?: string | null }>
  /** Latest community goon sightings: map id + epoch ms (as a string). */
  goonReports?: { map: string; timestamp: string | number }[]
}

export type RawMapsDoc = TranslatedBaseDoc<RawMapsData>

// ---------------------------------------------------------------------------
// Items: GET /{gameMode}/items   -> data.items is keyed by item id
// ---------------------------------------------------------------------------

export interface RawItem {
  id: string
  /** Translation keys ("<id> Name" / "<id> ShortName"). */
  name: string
  shortName: string
  normalizedName: string
  iconLink: string | null
  gridImageLink?: string | null
  /** 512 px picture (the Weapon builder shows it for weapons, parts and presets). */
  image512pxLink?: string | null
  wikiLink?: string | null
  basePrice: number
  avg24hPrice: number | null
  /** Player level needed to sell it on the flea (0 = the market's own level). */
  minLevelForFlea?: number | null
  lastLowPrice?: number | null
  low24hPrice?: number | null
  high24hPrice?: number | null
  changeLast48hPercent?: number | null
  /** ISO timestamp of the last price update. */
  updated?: string
  types: string[]
  width: number
  height: number
  weight: number
  stackMaxSize?: number | null
  categories?: string[]
  sellToTrader?: { trader: string; priceRUB: number }[]
  buyFromTrader?: { trader: string; priceRUB: number; minTraderLevel?: number; buyLimit?: number; taskUnlock?: string | null }[]
  /** Type-specific properties; ammo has propertiesType "ItemPropertiesAmmo". */
  properties?: RawItemProperties | null
  /** Items that cannot be fitted on the same weapon as this one. */
  conflictingItems?: string[]
  /** Presets only: the parts of the build (weapon, mods and loaded rounds). */
  containsItems?: { item: string; count?: number }[]
}

/** Only the ammo fields are read; other property types are ignored. */
export interface RawItemProperties {
  propertiesType?: string
  caliber?: string
  ammoType?: string
  damage?: number
  projectileCount?: number
  penetrationPower?: number
  armorDamage?: number
  fragmentationChance?: number
  ricochetChance?: number
  initialSpeed?: number
  tracer?: boolean
  tracerColor?: string
  accuracyModifier?: number
  recoilModifier?: number
  lightBleedModifier?: number
  heavyBleedModifier?: number
  // Weapons (ItemPropertiesWeapon) and weapon parts (WeaponMod/Scope/Barrel/Magazine)
  ergonomics?: number
  recoilVertical?: number
  recoilHorizontal?: number
  fireRate?: number
  effectiveDistance?: number
  fireModes?: string[]
  defaultPreset?: string | null
  presets?: string[]
  slots?: RawItemSlot[]
  // Presets (ItemPropertiesPreset)
  baseItem?: string
  default?: boolean
}

/** A slot on a weapon or weapon part. */
export interface RawItemSlot {
  id: string
  /** e.g. "mod_pistol_grip", "mod_scope_000". */
  nameId: string
  required?: boolean
  filters?: { allowedItems?: string[]; allowedCategories?: string[] } | null
}

export interface RawItemsData {
  items: Record<string, RawItem>
  itemCategories?: Record<string, { id?: string; name?: string; normalizedName?: string }>
  fleaMarket?: Record<string, unknown>
  /** 79 rows: { level, exp (total XP), levelBadgeImageLink }. */
  playerLevels?: { level: number; exp: number; levelBadgeImageLink?: string }[]
}

export type RawItemsDoc = TranslatedBaseDoc<RawItemsData>

// ---------------------------------------------------------------------------
// Price history: GET /{gameMode}/prices/{itemId}
// ---------------------------------------------------------------------------

export interface PricePoint {
  price: number
  priceMin: number
  /** Unix epoch milliseconds. */
  timestamp: number
}

export interface RawPriceHistoryDoc {
  data: PricePoint[]
}

// ---------------------------------------------------------------------------
// Status: GET /status
// ---------------------------------------------------------------------------

export interface ServiceStatus {
  name: string
  message?: string
  status: number
  statusCode: string
}

export interface RawStatusDoc {
  data: {
    generalStatus: ServiceStatus
    currentStatuses: ServiceStatus[]
    /** Battlestate's status notices (maintenance, outages); solveTime is set once over. */
    messages?: StatusMessage[]
  }
}

export interface StatusMessage {
  _id?: string
  content: string
  type: number
  time: string
  solveTime?: string | null
  statusCode: string
}

// ---------------------------------------------------------------------------
// App-facing (translated, resolved) types
// ---------------------------------------------------------------------------

export interface Trader {
  id: string
  name: string
  normalizedName: string
  imageLink: string | null
  currency: string
  /** Next restock as ms since epoch, or null when the data has none. */
  resetTime: number | null
  /** Number of loyalty levels (1 for the minor traders). */
  maxLevel: number
  /** Loyalty levels and what each needs (player level, reputation). Money spent is 0 in the data. */
  levels: { level: number; playerLevel: number; reputation: number }[]
}

export interface GameMap {
  id: string
  name: string
  normalizedName: string
  /** Matches the "scene preset path" line in the game log. */
  scenePath: string | null
  /** Matches the "Location:" value in the game log's raid lines. */
  nameId: string
  /** Raid length in minutes. */
  raidDuration: number
}

export interface QuestItem {
  id: string
  name: string
  shortName: string
  iconLink: string | null
}

export interface TraderPrice {
  traderId: string
  priceRUB: number
  minTraderLevel?: number
  /** Trader sale offers only: units per player per restock (0/absent = unknown). */
  buyLimit?: number
  /** Trader sale offers only: task id that must be completed to unlock the offer. */
  taskUnlock?: string | null
}

export interface Item {
  id: string
  name: string
  shortName: string
  normalizedName: string
  iconLink: string | null
  wikiLink: string | null
  avg24hPrice: number | null
  /** Player level needed to sell it on the flea, when the data has one above the market's own. */
  fleaLevel?: number | null
  lastLowPrice: number | null
  low24hPrice: number | null
  high24hPrice: number | null
  changeLast48hPercent: number | null
  basePrice: number
  width: number
  height: number
  types: string[]
  stackMaxSize?: number | null
  categories: string[]
  /** Trader buy-back offers (what a trader pays you), best first. */
  sellToTrader: TraderPrice[]
  /** Trader sale offers (what you pay), cheapest first. */
  buyFromTrader: TraderPrice[]
  updated: string | null
  /** Ballistics, only on ammo rounds (not grenades or ammo packs). */
  ammo?: AmmoStats
  /** Base stats and slots, only on firearms (Weapon builder). */
  weapon?: WeaponStats
  /** Stats, slots and conflicts, only on weapon parts (Weapon builder). */
  mod?: ModStats
  /** Only on weapon presets (ready-made builds). */
  preset?: PresetInfo
  /** Inventory-grid picture; only on weapons, parts and presets (Weapon builder). */
  gridImageLink?: string
  /** Large 512 px picture; only on weapons, parts and presets (Weapon builder). */
  image512Link?: string
  /** tarkov.dev has no pictures of this variant yet: the pictures are this item's (standard version). */
  pictureOf?: string
}

/** A slot on a weapon or part; `allowed` lists the item ids that fit. */
export interface ModSlot {
  id: string
  nameId: string
  required: boolean
  allowed: string[]
}

export interface WeaponStats {
  caliber: string
  ergonomics: number
  recoilVertical: number
  recoilHorizontal: number
  /** Rounds per minute. */
  fireRate: number
  /** Metres. */
  effectiveDistance: number
  fireModes: string[]
  /** kg, bare weapon. */
  weight: number
  slots: ModSlot[]
  defaultPreset: string | null
  presets: string[]
  conflicts: string[]
}

export interface ModStats {
  /** Added to the weapon's ergonomics. */
  ergonomics: number
  /** Fraction, e.g. -0.2 = 20 % less recoil. */
  recoilModifier: number
  /** Fraction. */
  accuracyModifier: number
  /** kg. */
  weight: number
  slots: ModSlot[]
  conflicts: string[]
}

export interface PresetInfo {
  baseItem: string
  /** Part ids in the preset (the weapon itself and loaded rounds removed). */
  parts: string[]
  ergonomics: number
  recoilVertical: number
  recoilHorizontal: number
  isDefault: boolean
}

/** Ammo ballistics from the items doc's `properties` (ItemPropertiesAmmo). */
export interface AmmoStats {
  /** Game calibre id, e.g. "Caliber556x45NATO". */
  caliber: string
  /** "bullet", "buckshot", "grenade" or "flashbang". */
  ammoType: string
  /** Flesh damage per projectile. */
  damage: number
  /** Pellets per shot (1 for bullets, 8 for most buckshot). */
  projectileCount: number
  penetrationPower: number
  /** Armour damage in percent (52 = 52 %). */
  armorDamage: number
  /** Chance 0..1. */
  fragmentationChance: number
  /** Chance 0..1. */
  ricochetChance: number
  /** Muzzle velocity in m/s. */
  initialSpeed: number
  tracer: boolean
  tracerColor: string | null
  /** Fraction, e.g. -0.05 = 5 % worse accuracy. */
  accuracyModifier: number
  /** Fraction, e.g. 0.05 = 5 % more recoil. */
  recoilModifier: number
  /** Fraction added to the bleed chance. */
  lightBleedModifier: number
  heavyBleedModifier: number
}

// ---------------------------------------------------------------------------
// Hideout: GET /{gameMode}/hideout  -> data keyed by station id; names via _en
// ---------------------------------------------------------------------------

export interface RawHideoutLevel {
  id: string
  level: number
  constructionTime: number
  traderRequirements: { trader: string; value: number; requirementType?: string }[]
  stationLevelRequirements: { station: string; level: number }[]
  itemRequirements: { id: string; item: string; count: number; attributes?: { foundInRaid?: boolean } }[]
  skillRequirements: { skill: string; level: number }[]
  bonuses: { type: string; name: string; value?: number; passive?: boolean; skill?: string }[]
  description: string
}

export interface RawHideoutStation {
  id: string
  name: string
  normalizedName: string
  areaType?: number
  imageLink?: string | null
  levels: RawHideoutLevel[]
}

export type RawHideoutDoc = TranslatedBaseDoc<Record<string, RawHideoutStation>>

export interface HideoutLevel {
  id: string
  level: number
  constructionTime: number
  traderRequirements: { traderId: string; level: number }[]
  stationLevelRequirements: { stationId: string; level: number }[]
  itemRequirements: { itemId: string; count: number | null; foundInRaid: boolean | null }[]
  skillRequirements: { skill: string; level: number }[]
  bonuses: { type: string; name: string; value: number | null; skill: string | null }[]
  description: string
}

export interface HideoutStation {
  id: string
  name: string
  normalizedName: string
  imageLink: string | null
  levels: HideoutLevel[]
}

// ---------------------------------------------------------------------------
// Crafts: GET /{gameMode}/crafts  -> data is an array
// ---------------------------------------------------------------------------

export interface RawCraft {
  id: string
  requiredItems: { item: string; count: number; attributes?: { tool?: boolean } }[]
  requiredQuestItems?: { id: string }[]
  station: string
  level: number
  duration: number
  productItem: { item: string; count: number }
}

export type RawCraftsDoc = TranslatedBaseDoc<RawCraft[] | Record<string, RawCraft>>

export interface Craft {
  id: string
  stationId: string
  level: number
  /** Seconds. */
  duration: number
  inputs: { itemId: string; count: number; tool: boolean }[]
  output: { itemId: string; count: number }
}

export interface TaskRequirement {
  taskId: string
  status: string[]
}

/** Where an objective happens on one map: zone centre(s) or item spawn points. */
export interface ObjectiveLocation {
  mapId: string
  positions: Position[]
  /** Zone polygon, when the objective is an area rather than points. */
  outline: Position[] | null
  zoneId: string | null
}

export interface TaskObjective {
  /** Raw item state restrictions unsupported by physical stack facts. */
  planningGaps?: string[]
  id: string
  type: string
  description: string
  optional: boolean
  maps: GameMap[]
  count: number | null
  /** Accepted item ids; resolve against the items query for names/icons. */
  itemIds: string[]
  questItem: QuestItem | null
  foundInRaid: boolean | null
  targetNames: string[]
  locations: ObjectiveLocation[]
  /** Key item ids: groups of alternatives, every group needed. */
  requiredKeys: string[][]
  /** Extract objectives: English extract name (matches MapExtract.name). */
  exitName: string | null
  /** Gunsmith-style build requirements; null for other objective types. */
  build: WeaponBuild | null
  /** mark objectives: marker item to bring. */
  markerItemId: string | null
  /** shoot objectives: weapons that count (any one). */
  usingWeaponIds: string[]
  /** shoot objectives: parts the weapon must carry (each set fitted whole; the sets are alternatives). */
  usingWeaponModIds: string[][]
  /** shoot objectives: kill or just hit. */
  shotType: 'kill' | 'hit' | null
  /** shoot objectives: body parts that count (game ids); empty = any. */
  bodyParts: string[]
  /** shoot objectives: distance limit, if any. */
  distance: { compare: '>=' | '<='; value: number } | null
  /** shoot objectives: in-game hours it has to happen between, if any. */
  hours: { from: number; until: number } | null
  /** shoot objectives: alternative outfits (any one), each a list of items worn together. */
  wearingIds: string[][]
}

export interface WeaponBuild {
  weaponId: string | null
  /** Parts that must be on the weapon (item ids). */
  partIds: string[]
  /** Part categories that must be present (category ids; names in ItemsBundle.categoryNames). */
  categoryIds: string[]
  /** Stat limits that matter (zero ">=" limits are dropped). */
  limits: { stat: string; compare: '>=' | '<=' | '=' ; value: number }[]
}

export interface MapExtract {
  id: string
  name: string
  faction: 'pmc' | 'scav' | 'shared'
  position: Position
  outline: Position[]
}

export interface MapTransit {
  id: string
  name: string
  targetMapId: string | null
  position: Position
  outline: Position[]
}

export interface MapSpawn {
  position: Position
  sides: string[]
  categories: string[]
  zoneName: string
}

export interface MapBoss {
  mobId: string | null
  name: string
  normalizedName: string
  spawnChance: number
  locations: { name: string; chance: number; positions: Position[] }[]
  /** Guards/escorts with the possible group sizes ("x2/3"). */
  escorts: { mobId: string; name: string; counts: number[] }[]
  /** Seconds after raid start before the boss can spawn; -1 = at start. */
  spawnTime: number
  spawnTimeRandom: boolean
  /** Switch/lever id when the spawn needs activating, else null. */
  trigger: string | null
}

export interface MapLock {
  id: string
  lockType: string
  keyId: string
  needsPower: boolean
  position: Position
}

export interface MapHazard {
  id: string
  type: string
  name: string
  position: Position
  outline: Position[]
}

export interface MapSwitch {
  id: string
  /** English name, or one read from the internal name ("Power switch"). */
  name: string
  /** "Open"/"Close" in the data. */
  switchType: string
  position: Position
}

export interface MapDetails {
  extracts: MapExtract[]
  transits: MapTransit[]
  spawns: MapSpawn[]
  bosses: MapBoss[]
  lootContainers: { containerId: string; position: Position }[]
  lootLoose: { position: Position; itemIds: string[] }[]
  locks: MapLock[]
  hazards: MapHazard[]
  switches: MapSwitch[]
  stationaryWeapons: { itemId: string; position: Position }[]
  btrStops: { name: string; position: Position }[]
}

export type FactionName = 'Any' | 'USEC' | 'BEAR'

export interface Task {
  id: string
  name: string
  normalizedName: string
  trader: Trader
  map: GameMap | null
  minPlayerLevel: number
  experience: number
  factionName: FactionName
  kappaRequired: boolean
  lightkeeperRequired: boolean
  wikiLink: string | null
  taskImageLink: string | null
  taskRequirements: TaskRequirement[]
  /**
   * Human-readable gates the app cannot track (trader loyalty level, trader
   * dialogue, story progression). Shown for information only.
   */
  otherRequirements: string[]
  /** Waiting time after the prerequisites are done before the trader offers it (seconds), or null. */
  availableDelay: { minS: number; maxS: number } | null
  /** Hidden progress counters the game checks ("globalVariable" requirements). */
  storyGates: { variableId: string; compare: string; value: number }[]
  /** Traders you must talk to first ("dialogue" requirements). */
  dialogueTraderIds: string[]
  objectives: TaskObjective[]
  /** Keys the task needs, per map id. */
  neededKeys: { mapId: string; keyIds: string[] }[]
  /** Trader gates: loyalty level or reputation, e.g. Prapor level >= 2. */
  traderRequirements: { traderId: string; type: string; compare: string; value: number }[]
  /** Reputation the hand-in gives (negative for some traders). */
  standing: { traderId: string; standing: number }[]
  /** Set only for quests that come from the EFT Wiki because the game data lacks them (api/wikiQuests.ts). */
  wiki?: { kind: 'regular' | 'event' | 'seasonal' | 'arena' | 'past'; rewards: string[]; requirements: string[]; locations: string[] }
}

/** Everything the Quests/Dashboard tabs need, loaded for one game mode. */
export interface GameData {
  gameMode: GameMode
  tasks: Task[]
  tasksById: Record<string, Task>
  traders: Trader[]
  maps: GameMap[]
  /** Extracts, transits, spawns etc. keyed by map id. */
  mapDetails: Record<string, MapDetails>
  /** Loot container names by container id (for MapDetails.lootContainers). */
  lootContainerNames: Record<string, string>
  /** Boss names by mob id (for MapDetails.bosses). */
  mobNames: Record<string, string>
  /** Boss portrait image by mob id, when the data has one. */
  mobPortraits: Record<string, string>
  /** Map id the Goons were last reported on (from goonReports), with the report time. */
  goonReport: { mapId: string; at: number } | null
  /** When the data was fetched (for the "updated" hint in the UI). */
  fetchedAt: number
}

export type ItemsById = Record<string, Item>

/** One row of the game's level table: total XP needed to reach `level`. */
export interface PlayerLevel {
  level: number
  exp: number
}

/** Result of the items document: the item catalogue plus the level table it ships with. */
export interface ItemsBundle {
  items: ItemsById
  playerLevels: PlayerLevel[]
  /** Item category id -> English name (e.g. weapon part types). */
  categoryNames: Record<string, string>
}

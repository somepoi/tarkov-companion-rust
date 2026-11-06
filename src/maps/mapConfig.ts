/**
 * Map imagery configuration: every map has one or more "base layers" (images),
 * each with its own affine transform from game coordinates to image pixels.
 *
 * Sources
 *  - tarkov.dev layers come from src/data/mapConfig.json, vendored verbatim from
 *    https://github.com/the-hideout/tarkov-dev (src/data/maps.json, MIT). The
 *    JSON records the commit it was copied from. Their imagery is served from
 *    assets.tarkov.dev and credited per map.
 *  - Extra layers (third-party renders we align ourselves) are declared in
 *    EXTRA_BASE_LAYERS below. Their affine comes from the /dev/align tool:
 *    paste the "Copy transform" output into the layer's `affine`.
 *
 * The tarkov.dev JSON API's /maps document has no image or transform data at
 * all (only `coordinateToCardinalRotation`), so these are the only sources for a
 * working image + coordinate system.
 */

import raw from '../data/mapConfig.json'
import { affineFromTarkovDev, boundsFromImage, type Affine, type GameBounds } from './projection'

export type { GameBounds } from './projection'

/**
 * A height range that belongs to a floor, optionally limited to buildings:
 * `bounds` holds rectangles as [[x, z], [x, z], label?] in game coordinates.
 */
export interface FloorExtent {
  height: [number, number]
  bounds?: [[number, number], [number, number], ...unknown[]][]
}

export interface FloorLayerConfig {
  /** Display name, e.g. "2nd Floor". */
  name: string
  /** Id of the <g> group inside the base layer's SVG that draws this floor. */
  svgLayer?: string
  /** Tile pyramid for this floor, when it exists as raster imagery. */
  tilePath?: string
  /** Shown by default (e.g. Interchange opens on the 2nd floor). */
  show: boolean
  /** Height ranges (and buildings) that belong to this floor. */
  extents?: FloorExtent[]
}

export interface LayerCredit {
  /** e.g. "tarkov.dev", "RE3MR" */
  name: string
  link?: string
  /** e.g. "MIT", "CC BY-NC-SA 4.0" */
  license?: string
  /** What the picture is in the credit line ("render" when absent). */
  what?: 'render' | 'drawing'
  /** Individual map author, when known. */
  author?: string
  authorLink?: string
}

export interface BaseLayerConfig {
  /** Desktop: content pack that must be downloaded before this image can show (electron/packs.ts). */
  pack?: 'lighthouse'
  /** Stable id, stored in user preferences. */
  id: string
  /** Shown in the layer selector. */
  label: string
  kind: 'tiles' | 'svg'
  /** Tile URL template ("{z}/{x}/{y}") for kind "tiles". */
  tilePath?: string
  tileSize?: number
  /** SVG document: the base image for kind "svg", and the source of SVG floors for kind "tiles". */
  svgPath?: string
  /** Id of the ground-floor <g> group inside the SVG. */
  svgLayer?: string
  /** Bounds for the SVG when they differ from the tile bounds (Reserve). */
  svgBounds?: GameBounds
  /** Native zoom range of the imagery. */
  minZoom: number
  maxZoom: number
  /** Game (x, z) -> zoom-0 pixel transform. */
  affine: Affine
  /** Image extent in game coordinates [[x, z], [x, z]] (bounding box). */
  bounds: GameBounds
  floors: FloorLayerConfig[]
  credit: LayerCredit
  /** Explanation of imagery age or limits, shown above the map. */
  note?: string
  /** Known to be out of date; labelled as such in the selector. */
  outdated?: boolean
}

export interface MapConfig {
  /** tarkov.dev key, e.g. "customs". */
  key: string
  /** Matches the API map's normalizedName for primary maps. */
  normalizedName: string
  /** API normalizedNames that reuse this config (night-factory, ground-zero-21, the-lab-dark). */
  altMaps?: string[]
  baseLayers: BaseLayerConfig[]
  defaultBaseLayerId: string
}

// ---------------------------------------------------------------------------
// Vendored tarkov.dev config (shape of src/data/mapConfig.json)
// ---------------------------------------------------------------------------

interface TarkovDevLayer {
  name: string
  svgLayer?: string
  tilePath?: string
  show: boolean
  extents?: FloorExtent[]
}

interface TarkovDevMap {
  key: string
  normalizedName: string
  minZoom: number
  maxZoom: number
  transform: [number, number, number, number]
  coordinateRotation: number
  bounds: GameBounds
  author?: string
  authorLink?: string
  svgPath?: string
  svgLayer?: string
  svgBounds?: GameBounds
  tilePath?: string
  tileSize?: number
  heightRange?: [number, number]
  altMaps?: string[]
  layers: TarkovDevLayer[]
  preferredStyle?: 'tile' | 'svg'
  imageryNote?: string
}

interface TarkovDevConfigFile {
  _source: Record<string, string>
  maps: TarkovDevMap[]
}

const file = raw as unknown as TarkovDevConfigFile
export const MAP_CONFIG_SOURCE = file._source

export const TARKOV_DEV_PHOTO = 'tarkovdev-photo'
export const TARKOV_DEV_DRAWING = 'tarkovdev-drawing'

const TARKOV_DEV_CREDIT = (m: TarkovDevMap): LayerCredit => ({
  name: 'tarkov.dev',
  link: 'https://tarkov.dev/maps',
  license: 'MIT',
  author: m.author,
  authorLink: m.authorLink,
})

function tarkovDevLayers(m: TarkovDevMap): BaseLayerConfig[] {
  const affine = affineFromTarkovDev(m.transform, m.coordinateRotation)
  const shared = {
    svgPath: m.svgPath,
    svgLayer: m.svgLayer,
    svgBounds: m.svgBounds,
    minZoom: m.minZoom,
    maxZoom: m.maxZoom,
    affine,
    bounds: m.bounds,
    floors: m.layers,
    credit: TARKOV_DEV_CREDIT(m),
  }
  const out: BaseLayerConfig[] = []
  if (m.tilePath) {
    out.push({
      ...shared,
      id: TARKOV_DEV_PHOTO,
      label: 'tarkov.dev photo',
      kind: 'tiles',
      tilePath: m.tilePath,
      tileSize: m.tileSize,
      note: m.preferredStyle === 'svg' ? m.imageryNote : undefined,
      outdated: m.preferredStyle === 'svg',
    })
  }
  if (m.svgPath) {
    out.push({
      ...shared,
      id: TARKOV_DEV_DRAWING,
      label: 'tarkov.dev drawing',
      kind: 'svg',
      note: m.preferredStyle !== 'svg' ? m.imageryNote : undefined,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Extra base layers (Tarkov Companion additions)
// ---------------------------------------------------------------------------

/** RE3MR Lighthouse render: 8259 x 7560 px sliced into a 7-level pyramid (zoom-0 = source / 64). */
const RE3MR_LIGHTHOUSE_SIZE: [number, number] = [8259 / 64, 7560 / 64]
/**
 * First-pass fit on 2026-10-03 from 15 extract/transit icons on the render
 * matched to API positions (RMS ~20 m; icons sit near, not exactly on, the
 * points). Refine with /dev/align and paste the result here.
 */
const RE3MR_LIGHTHOUSE_AFFINE: Affine = [-0.079955, 0.000654, 84.375332, 0.00125, 0.064708, 68.316682]

interface ExtraLayers {
  layers: BaseLayerConfig[]
  defaultBaseLayerId?: string
  /** Relabel/mark existing tarkov.dev layers. */
  overrides?: Record<string, Partial<Pick<BaseLayerConfig, 'label' | 'note' | 'outdated'>>>
}

/** Our updated Lighthouse drawing keeps tarkov.dev's frame (viewBox, bounds, transform). */
const TD_LIGHTHOUSE = file.maps.find((m) => m.normalizedName === 'lighthouse')
export const LIGHTHOUSE_2026 = 'drawing-2026'
const LIGHTHOUSE_DRAWING_PATH = 'tiles/lighthouse-re3mr/drawing-2026.svg'

export const EXTRA_BASE_LAYERS: Record<string, ExtraLayers> = {
  lighthouse: {
    defaultBaseLayerId: LIGHTHOUSE_2026,
    layers: [
      {
        id: LIGHTHOUSE_2026,
        label: 'Updated drawing (2026)',
        kind: 'svg',
        // In the Lighthouse content pack with the render (same licence); see scripts/lighthouse-map.
        svgPath: typeof window !== 'undefined' && window.desktop && !import.meta.env.DEV
          ? window.desktop.appResourceUrl?.(LIGHTHOUSE_DRAWING_PATH) ?? `tcres://app/${LIGHTHOUSE_DRAWING_PATH}`
          : `${import.meta.env.BASE_URL}${LIGHTHOUSE_DRAWING_PATH}`,
        svgLayer: 'Ground_Level',
        pack: 'lighthouse',
        minZoom: TD_LIGHTHOUSE?.minZoom ?? 1,
        maxZoom: TD_LIGHTHOUSE?.maxZoom ?? 6,
        affine: affineFromTarkovDev(TD_LIGHTHOUSE?.transform ?? [0.2, 0, 0.2, 0], TD_LIGHTHOUSE?.coordinateRotation ?? 180),
        bounds: TD_LIGHTHOUSE?.bounds ?? [[515, -998], [-545, 725]],
        floors: [],
        credit: {
          what: 'drawing',
          name: "Jindouz's 2D map (layout) in the tarkov.dev SVG maps style",
          link: 'https://escapefromtarkov.fandom.com/wiki/Lighthouse',
          license: 'CC BY-SA 3.0 (layout), CC BY-NC-SA 4.0 (style and border)',
          author: 'Jindouz, Shebuka',
          authorLink: 'https://github.com/the-hideout/tarkov-dev-svg-maps',
        },
        note: "Today's layout (September 2026) in the flat drawing style: ground, roads, paths, buildings, the water plant, the rebuilt lighthouse island and the causeway from Jindouz's 2D map, placed on the game's own positions so containers and loot sit in the right buildings; minefields from the game data.",
      },
      {
        id: 're3mr',
        label: 'RE3MR render',
        kind: 'tiles',
        // Web: served with the site. Desktop: the app's own file server (a content pack that is
        // downloaded the first time this map is opened; see electron/packs.ts).
        tilePath: typeof window !== 'undefined' && window.desktop ? `${window.desktop.appResourceUrl?.('tiles/lighthouse-re3mr') ?? 'tcres://app/tiles/lighthouse-re3mr'}/{z}/{x}/{y}.png` : `${import.meta.env.BASE_URL}tiles/lighthouse-re3mr/{z}/{x}/{y}.png`,
        pack: 'lighthouse',
        tileSize: 256,
        minZoom: 1,
        maxZoom: 6,
        affine: RE3MR_LIGHTHOUSE_AFFINE,
        bounds: boundsFromImage(RE3MR_LIGHTHOUSE_AFFINE, RE3MR_LIGHTHOUSE_SIZE[0], RE3MR_LIGHTHOUSE_SIZE[1]),
        floors: [],
        credit: {
          name: 'RE3MR',
          link: 'https://reemr.se',
          license: 'CC BY-NC-SA 4.0',
          author: 're3mr',
          authorLink: 'https://reemr.se/maps/Lighthouse/',
        },
        note: 'Post-1.1.5 layout rendered by RE3MR. Alignment is a first pass (about 20 m accuracy); refine it with the alignment tool.',
      },
    ],
    overrides: {
      [TARKOV_DEV_DRAWING]: {
        label: 'tarkov.dev drawing (pre-1.1.5, outdated)',
        outdated: true,
        note: 'This drawing predates the 1.1.5 Lighthouse rework and no longer matches the map.',
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Assembled configs
// ---------------------------------------------------------------------------

function buildConfig(m: TarkovDevMap): MapConfig {
  const extra = EXTRA_BASE_LAYERS[m.normalizedName]
  let layers = tarkovDevLayers(m)
  if (extra?.overrides) {
    layers = layers.map((l) => (extra.overrides?.[l.id] ? { ...l, ...extra.overrides[l.id] } : l))
  }
  if (extra?.layers) layers = [...extra.layers, ...layers]
  const preferred =
    extra?.defaultBaseLayerId ??
    (m.preferredStyle === 'svg' && m.svgPath ? TARKOV_DEV_DRAWING : m.tilePath ? TARKOV_DEV_PHOTO : TARKOV_DEV_DRAWING)
  return {
    key: m.key,
    normalizedName: m.normalizedName,
    altMaps: m.altMaps,
    baseLayers: layers,
    defaultBaseLayerId: layers.some((l) => l.id === preferred) ? preferred : layers[0].id,
  }
}

export const MAP_CONFIGS: MapConfig[] = file.maps.map(buildConfig)

/** Display order for the selector; anything else follows alphabetically. */
export const PREFERRED_MAP_ORDER = [
  'customs',
  'woods',
  'shoreline',
  'interchange',
  'reserve',
  'factory',
  'lighthouse',
  'streets-of-tarkov',
  'ground-zero',
  'the-lab',
  'terminal',
  'the-labyrinth',
  'icebreaker',
]

/** Finds the config for an API map by normalizedName, including alt variants. */
export function findMapConfig(normalizedName: string): MapConfig | undefined {
  return (
    MAP_CONFIGS.find((m) => m.normalizedName === normalizedName) ??
    MAP_CONFIGS.find((m) => m.altMaps?.includes(normalizedName))
  )
}

export function mapOrderIndex(normalizedName: string): number {
  const cfg = findMapConfig(normalizedName)
  const primary = cfg?.normalizedName ?? normalizedName
  const i = PREFERRED_MAP_ORDER.indexOf(primary)
  const base = i === -1 ? 1000 : i * 10
  return primary === normalizedName ? base : base + 1
}

/** True when a floor's imagery is available to draw on this base layer. */
export function floorIsDrawable(floor: FloorLayerConfig, layer: BaseLayerConfig): boolean {
  return Boolean(floor.tilePath || (floor.svgLayer && layer.svgPath))
}

export function resolveBaseLayer(cfg: MapConfig, preferredId: string | undefined): BaseLayerConfig {
  return (
    cfg.baseLayers.find((l) => l.id === preferredId) ??
    cfg.baseLayers.find((l) => l.id === cfg.defaultBaseLayerId) ??
    cfg.baseLayers[0]
  )
}

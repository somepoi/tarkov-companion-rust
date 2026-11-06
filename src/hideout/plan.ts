/**
 * The Hideout tab's floor plan: the bunker as the game's overview camera shows it (looking down
 * diagonally), rooms, walls and where each station stands. Nothing in the game data says where
 * stations are, so the spots were read from in-game overview screenshots (three views of a
 * PvE hideout, 2026-10-27): four corners of the hall fix the game camera's perspective, which
 * turns each station icon into a plan spot; the far end came from a second view joined by an
 * affine fit (5-24 px apart on the shared stations).
 * Stations that were not built in those screenshots are placed approximately (`source: 'approx'`)
 * and the player can drag any station to its real spot (store/hideoutSpots.ts).
 *
 * Plan coordinates are metres-ish: u runs along the hall's lower-left wall (down-right on
 * screen), v along its right wall (up-right on screen). The entrance and the Cultist Circle room
 * sit at 45 degrees to the hall, as in the game.
 */

export type Pt = [number, number]

export type Effect =
  | 'power' | 'fan' | 'heat' | 'water' | 'btc' | 'booze' | 'scan' | 'ritual' | 'med' | 'cam'
  | 'light' | 'sun' | 'food' | 'rest' | 'tools' | 'range' | 'gym' | 'trophy' | 'none'

export interface Spot {
  at: Pt
  /** 'shot' = seen in in-game overview screenshots; 'approx' = not seen yet. */
  source: 'shot' | 'approx'
}

export const WALL_STATION = 'defective-wall'

/** Screen units per plan metre, and the camera's look (the game's overview angle). */
const K = 40
const UX: Pt = [0.866 * K, 0.5 * K]
const VX: Pt = [0.766 * K, -0.643 * K]
/** How tall walls are drawn, in screen units. */
export const WALL_H = 16

export function project([u, v]: Pt): Pt {
  return [u * UX[0] + v * VX[0], u * UX[1] + v * VX[1]]
}

export function unproject([x, y]: Pt): Pt {
  const det = UX[0] * VX[1] - VX[0] * UX[1]
  return [(x * VX[1] - VX[0] * y) / det, (UX[0] * y - x * UX[1]) / det]
}

/** The SVG transform that draws plan coordinates on screen (floors, light pools, the chalk circle). */
export const PLAN_MATRIX = `matrix(${UX[0]} ${UX[1]} ${VX[0]} ${VX[1]} 0 0)`

// The entrance wing: origin in the middle of the hall's cut corner, t along the cut, n away from the hall.
const E0: Pt = [15, 2]
const T: Pt = [Math.SQRT1_2, Math.SQRT1_2]
const N: Pt = [Math.SQRT1_2, -Math.SQRT1_2]
export function wing(t: number, n: number): Pt {
  return [E0[0] + t * T[0] + n * N[0], E0[1] + t * T[1] + n * N[1]]
}
const wingRect = (t0: number, t1: number, n0: number, n1: number): Pt[] => [wing(t0, n0), wing(t1, n0), wing(t1, n1), wing(t0, n1)]
const rect = (u0: number, u1: number, v0: number, v1: number): Pt[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]

export interface Floor {
  id: string
  name: string
  points: Pt[]
  /** Only opens once the Defective Wall is fully rebuilt. */
  hidden?: boolean
}

export const FLOORS: Floor[] = [
  { id: 'hall', name: 'Main hall', points: [[0, 0], [13, 0], [17, 4], [17, 32], [8, 32], [8, 12], [0, 12]] },
  { id: 'range', name: 'Shooting range', points: rect(-9, 0, 2, 7) },
  { id: 'hidden', name: 'Hidden room', points: rect(0, 8, 12, 23), hidden: true },
  { id: 'security', name: 'Entrance', points: wingRect(-2.83, 2.83, 0, 5) },
  { id: 'corridor', name: 'Corridor', points: [...wingRect(-2.6, -0.8, 5, 11).slice(0, 2), wing(-0.8, 8.6), wing(4.5, 8.6), wing(4.5, 11), wing(-2.6, 11)] },
  { id: 'cultist', name: 'Circle room', points: wingRect(4.5, 12.5, 4, 12.5) },
]

export interface Wall {
  a: Pt
  b: Pt
  /** The Defective Wall's own section. */
  defective?: boolean
}

/** Walls with gaps for the doors. */
export const WALLS: Wall[] = [
  // Main hall.
  { a: [0, 0], b: [13, 0] },
  { a: [13, 0], b: wing(-1, 0) },
  { a: wing(1, 0), b: [17, 4] },
  { a: [17, 4], b: [17, 32] },
  { a: [17, 32], b: [8, 32] },
  { a: [8, 32], b: [8, 19] },
  { a: [8, 19], b: [8, 16.8], defective: true },
  { a: [8, 16.8], b: [8, 12] },
  { a: [8, 12], b: [0, 12] },
  { a: [0, 12], b: [0, 7] },
  { a: [0, 2], b: [0, 0] },
  // Shooting range.
  { a: [-9, 2], b: [0, 2] },
  { a: [-9, 7], b: [0, 7] },
  { a: [-9, 2], b: [-9, 7] },
  // Hidden room.
  { a: [0, 12], b: [0, 23] },
  { a: [0, 23], b: [8, 23] },
  // Entrance, corridor and the Circle room.
  { a: wing(-2.83, 0), b: wing(-2.83, 5) },
  { a: wing(2.83, 0), b: wing(2.83, 5) },
  { a: wing(-2.83, 5), b: wing(-2.6, 5) },
  { a: wing(-0.8, 5), b: wing(2.83, 5) },
  { a: wing(-2.6, 5), b: wing(-2.6, 11) },
  { a: wing(-0.8, 5), b: wing(-0.8, 8.6) },
  { a: wing(-0.8, 8.6), b: wing(4.5, 8.6) },
  { a: wing(-2.6, 11), b: wing(4.5, 11) },
  { a: wing(4.5, 4), b: wing(4.5, 8.6) },
  { a: wing(4.5, 11), b: wing(4.5, 12.5) },
  { a: wing(4.5, 4), b: wing(12.5, 4) },
  { a: wing(12.5, 4), b: wing(12.5, 12.5) },
  { a: wing(4.5, 12.5), b: wing(12.5, 12.5) },
]

/** Where the chalk circle is drawn (Cultist Circle room). */
export const CIRCLE: { at: Pt; r: number } = { at: wing(8.5, 8.25), r: 2.7 }

/** Ceiling lamps: pools of light that get brighter with Illumination. */
export const LAMPS: Pt[] = [[3.5, 2.5], [9.5, 3], [5.5, 9], [11.5, 9.5], [12.5, 18], [12.5, 25], [12.5, 29.5], [-5, 4.5], [4, 17.5], wing(0, 2.5), wing(-1.7, 8.5), wing(8.5, 8.25)]

export const SPOTS: Record<string, Spot> = {
  'shooting-range': { at: [0.8, 4.4], source: 'shot' },
  workbench: { at: [4, 8], source: 'shot' },
  'intelligence-center': { at: [6.8, 8.5], source: 'shot' },
  'water-collector': { at: [9.8, 13.9], source: 'shot' },
  illumination: { at: [10.1, 10.1], source: 'shot' },
  'defective-wall': { at: [9.4, 17.9], source: 'shot' },
  medstation: { at: [10, 22.8], source: 'shot' },
  'rest-space': { at: [10.2, 30], source: 'shot' },
  heating: { at: [16.2, 30], source: 'shot' },
  'nutrition-unit': { at: [16.2, 19.2], source: 'shot' },
  lavatory: { at: [4.4, 0.8], source: 'shot' },
  stash: { at: [9.7, 0.8], source: 'shot' },
  vents: { at: [13.4, 5.8], source: 'shot' },
  generator: { at: [15.9, 7.3], source: 'shot' },
  security: { at: wing(0.5, 2.6), source: 'shot' },
  'cultist-circle': { at: CIRCLE.at, source: 'shot' },
  library: { at: [13.2, 31], source: 'approx' },
  'booze-generator': { at: [12.8, 14.8], source: 'approx' },
  'bitcoin-farm': { at: [15.8, 12.8], source: 'approx' },
  'air-filtering-unit': { at: [12.4, 3.6], source: 'approx' },
  'solar-power': { at: [15.6, 4.6], source: 'approx' },
  'scav-case': { at: wing(-1.6, 2.4), source: 'approx' },
  'weapon-rack': { at: [7, 0.8], source: 'approx' },
  gym: { at: [3.5, 19.5], source: 'approx' },
  'hall-of-fame': { at: [6, 15], source: 'approx' },
  'gear-rack': { at: [2.2, 15], source: 'approx' },
}

/** A spot for every station: known ones from SPOTS, anything new in the data along the middle of the hall. */
export function spotsFor(normalizedNames: string[]): Record<string, Spot> {
  const out: Record<string, Spot> = {}
  let spare = 0
  for (const n of normalizedNames) out[n] = SPOTS[n] ?? { at: [3 + (spare++ % 5) * 2.4, 5 + Math.floor(spare / 6) * 2], source: 'approx' }
  return out
}

/** Keeps a dragged station inside the drawing. */
export function clampSpot([u, v]: Pt): Pt {
  const box = planBox()
  const [x, y] = project([u, v])
  const cx = Math.min(box.x + box.w - 20, Math.max(box.x + 20, x))
  const cy = Math.min(box.y + box.h - 20, Math.max(box.y + 20, y))
  const [cu, cv] = unproject([cx, cy])
  return [Math.round(cu * 10) / 10, Math.round(cv * 10) / 10]
}

/** Screen box of the whole drawing (walls included), with room for the station markers. */
export function planBox(): { x: number; y: number; w: number; h: number } {
  const pts = FLOORS.flatMap((f) => f.points).map(project)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const pad = 46
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad - WALL_H
  return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y }
}

/** How dark the floors are drawn for an Illumination level (0 = candles not even lit). */
export function darkness(illumination: number, max: number): number {
  if (max <= 0) return 0
  return Math.round(Math.max(0, 1 - illumination / max) * 0.45 * 100) / 100
}

export const EFFECTS: Record<string, Effect> = {
  generator: 'power',
  vents: 'fan',
  'air-filtering-unit': 'fan',
  heating: 'heat',
  'water-collector': 'water',
  lavatory: 'water',
  'bitcoin-farm': 'btc',
  'booze-generator': 'booze',
  'intelligence-center': 'scan',
  'cultist-circle': 'ritual',
  medstation: 'med',
  security: 'cam',
  illumination: 'light',
  'solar-power': 'sun',
  'nutrition-unit': 'food',
  'rest-space': 'rest',
  workbench: 'tools',
  'shooting-range': 'range',
  gym: 'gym',
  'hall-of-fame': 'trophy',
}

/** Floors drawn back to front, then walls back to front (painter's order for the raised walls). */
export function wallsInDrawOrder(walls: Wall[] = WALLS): Wall[] {
  const depth = (w: Wall) => Math.max(project(w.a)[1], project(w.b)[1])
  return [...walls].sort((p, q) => depth(p) - depth(q))
}

/**
 * Where the search bar's boxes sit. The bar's window covers the work area of one screen and is
 * cut to the shape of what is drawn (main.ts setShape), so every box (a card, the map, each side
 * panel) can be dragged and resized on its own while the rest of the screen stays the game's.
 * Positions are screen pixels, saved per box; boxes never moved open next to the glass.
 */
import type { Flip } from './shell'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Point {
  x: number
  y: number
}

/** A box moved (and maybe resized) by hand. w/h only once resized. */
export interface BoxPos {
  x: number
  y: number
  w?: number
  h?: number
}

/** The glass with its margin. */
export const GLASS = 48
/** Space between boxes opened next to each other. */
export const GAP = 8
/** Smallest box the resize corner allows. */
export const MIN_W = 220
export const MIN_H = 120

/** Things open towards the side of the screen with more room. */
export function openSide(anchor: Point, frame: Rect): Flip {
  return { left: anchor.x - frame.x > frame.width * 0.55, up: anchor.y - frame.y > frame.height * 0.55 }
}

/**
 * CSS position of something hanging off the glass (window coordinates), growing away from the near
 * screen edges. dx/dy move it further away from the glass (leftwards/upwards when flipped).
 */
export function anchorStyle(anchor: Point, frame: Rect, flip: Flip, dx = 0, dy = 0): { left?: number; right?: number; top?: number; bottom?: number } {
  const x = flip.left ? { right: frame.x + frame.width - (anchor.x + GLASS) + dx } : { left: anchor.x - frame.x + dx }
  const y = flip.up ? { bottom: frame.y + frame.height - (anchor.y + GLASS) + dy } : { top: anchor.y - frame.y + dy }
  return { ...x, ...y }
}

/** Left edge (window x) of a box this wide hanging off the glass on its open side, kept inside the window. */
export function hangX(anchor: Point, frame: Rect, flip: Flip, width: number): number {
  const gx = anchor.x - frame.x
  const x = flip.left ? gx + GLASS - width : gx
  return Math.round(Math.max(0, Math.min(x, frame.width - width)))
}

/** Where a box opens: window x of its left edge, dy away from the glass vertically (as anchorStyle). */
export function boxPlace(anchor: Point, frame: Rect, flip: Flip, x: number, dy = 0): { left: number; top?: number; bottom?: number } {
  const { top, bottom } = anchorStyle(anchor, frame, flip, 0, dy)
  return top === undefined ? { left: Math.round(x), bottom } : { left: Math.round(x), top }
}

/** Overlapping panels step this far from each other so every move bar stays in reach. */
export const STACK_STEP = 34

/**
 * Where side panels of these widths open (window x of each left edge, dy = how far they step away from the glass):
 * in a row beside the search column on the side it opens towards, then on the other side, never
 * off the screen. When neither side has room left, the rest overlap at the roomier edge, each a
 * step lower so their move bars show.
 */
export function panelSpots(col: { left: number; right: number }, windowWidth: number, widths: number[], preferLeft: boolean): { x: number; dy: number }[] {
  let right = col.right + GAP
  let left = col.left - GAP
  let stacked = 0
  const out: { x: number; dy: number }[] = []
  for (const panelW of widths) {
    const fitsRight = right + panelW <= windowWidth
    const fitsLeft = left - panelW >= 0
    if (fitsLeft && (preferLeft || !fitsRight)) {
      out.push({ x: left - panelW, dy: 0 })
      left -= panelW + GAP
    } else if (fitsRight) {
      out.push({ x: right, dy: 0 })
      right += panelW + GAP
    } else {
      stacked++
      const atLeft = col.left >= windowWidth - col.right
      out.push({ x: atLeft ? 0 : Math.max(0, windowWidth - panelW), dy: (stacked - 1) * STACK_STEP })
    }
  }
  return out.map((p) => ({ x: Math.round(p.x), dy: p.dy }))
}

/**
 * How far a box that opened at its default spot has to shift to be fully inside the window
 * (it opened by the glass, and content can grow it past the screen's edge). Too big = top left shows.
 */
export function nudgeInto(r: Rect, width: number, height: number): Point {
  const fit = (start: number, size: number, room: number) => (size >= room || start < 0 ? -start : Math.min(0, room - (start + size)))
  return { x: Math.round(fit(r.x, r.width, width)), y: Math.round(fit(r.y, r.height, height)) }
}

/** Keeps a moved box on the screen: at least its move bar can still be grabbed. */
export function clampPos(p: BoxPos, frame: Rect, keep = 90): BoxPos {
  const x = Math.min(Math.max(p.x, frame.x - (p.w ?? 300) + keep), frame.x + frame.width - keep)
  const y = Math.min(Math.max(p.y, frame.y), frame.y + frame.height - 36)
  const w = p.w === undefined ? undefined : Math.min(Math.max(p.w, MIN_W), frame.width)
  const h = p.h === undefined ? undefined : Math.min(Math.max(p.h, MIN_H), frame.y + frame.height - y)
  return { x: Math.round(x), y: Math.round(y), ...(w === undefined ? {} : { w: Math.round(w) }), ...(h === undefined ? {} : { h: Math.round(h) }) }
}

/** Saved boxes from storage: only sane numbers, at most 60 boxes. */
export function cleanBoxes(v: unknown): Record<string, BoxPos> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, BoxPos> = {}
  const num = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) < 100_000
  for (const [id, raw] of Object.entries(v as Record<string, unknown>).slice(0, 60)) {
    if (!/^[a-z][a-z0-9:#-]{0,60}$/i.test(id) || !raw || typeof raw !== 'object') continue
    const p = raw as Record<string, unknown>
    if (!num(p.x) || !num(p.y)) continue
    const box: BoxPos = { x: Math.round(p.x as number), y: Math.round(p.y as number) }
    if (num(p.w) && (p.w as number) >= MIN_W) box.w = Math.round(p.w as number)
    if (num(p.h) && (p.h as number) >= MIN_H) box.h = Math.round(p.h as number)
    out[id] = box
  }
  return out
}

/**
 * The window's shape: the drawn parts (window coordinates), rounded outwards with a small margin
 * for shadows. Empty or off-window parts are dropped; the window is never left with no shape.
 */
export function shapeRects(parts: Rect[], width: number, height: number, margin = 2): Rect[] {
  const out: Rect[] = []
  for (const r of parts) {
    const x0 = Math.max(0, Math.floor(r.x - margin))
    const y0 = Math.max(0, Math.floor(r.y - margin))
    const x1 = Math.min(width, Math.ceil(r.x + r.width + margin))
    const y1 = Math.min(height, Math.ceil(r.y + r.height + margin))
    if (x1 - x0 >= 1 && y1 - y0 >= 1) out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
  }
  return out.slice(0, 64)
}

/** Several boxes of one kind (two quest panels) each keep their own spot. */
export function boxIds(kinds: string[]): string[] {
  const seen = new Map<string, number>()
  return kinds.map((k) => {
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return n ? `${k}#${n}` : k
  })
}

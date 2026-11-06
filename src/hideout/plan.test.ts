import { describe, expect, it } from 'vitest'
import { clampSpot, darkness, FLOORS, planBox, project, SPOTS, spotsFor, unproject, wing, type Pt } from './plan'

/** Point in polygon (even-odd). */
function inside(poly: Pt[], [x, y]: Pt): boolean {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

describe('plan camera', () => {
  it('turns a screen point back into the same plan spot', () => {
    for (const p of [[0, 0], [13.4, 5.8], [-5, 4.5], wing(8.5, 8.25)] as Pt[]) {
      const back = unproject(project(p))
      expect(back[0]).toBeCloseTo(p[0], 6)
      expect(back[1]).toBeCloseTo(p[1], 6)
    }
  })

  it('looks at the hall like the game: the lower-left wall runs down-right, the right wall up-right', () => {
    const [ax, ay] = project([13, 0])
    expect(ax).toBeGreaterThan(0)
    expect(ay).toBeGreaterThan(0)
    const [bx, by] = project([17, 32])
    const [cx, cy] = project([17, 4])
    expect(bx).toBeGreaterThan(cx)
    expect(by).toBeLessThan(cy)
  })
})

describe('station spots', () => {
  it('puts every known station inside a room', () => {
    for (const [name, spot] of Object.entries(SPOTS)) {
      expect(FLOORS.some((f) => inside(f.points, spot.at)), name).toBe(true)
    }
  })

  it('keeps stations apart so the markers do not cover each other', () => {
    const list = Object.entries(SPOTS).map(([n, s]) => [n, project(s.at)] as const)
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = Math.hypot(list[i][1][0] - list[j][1][0], list[i][1][1] - list[j][1][1])
        expect(d, `${list[i][0]} / ${list[j][0]}`).toBeGreaterThan(60)
      }
    }
  })

  it('places the behind-the-wall stations in the hidden room', () => {
    const hidden = FLOORS.find((f) => f.id === 'hidden')!
    for (const n of ['gym', 'hall-of-fame', 'gear-rack']) expect(inside(hidden.points, SPOTS[n].at), n).toBe(true)
  })

  it('gives stations new to the data a spot of their own', () => {
    const out = spotsFor(['generator', 'christmas-tree', 'new-thing'])
    expect(out.generator.source).toBe('shot')
    expect(out['christmas-tree'].source).toBe('approx')
    expect(out['christmas-tree'].at).not.toEqual(out['new-thing'].at)
  })

  it('keeps a dragged station inside the drawing', () => {
    const box = planBox()
    const [x, y] = project(clampSpot([500, -500]))
    expect(x).toBeLessThanOrEqual(box.x + box.w)
    expect(y).toBeGreaterThanOrEqual(box.y)
  })
})

describe('darkness', () => {
  it('goes from dim to fully lit', () => {
    expect(darkness(0, 3)).toBe(0.45)
    expect(darkness(3, 3)).toBe(0)
    expect(darkness(5, 0)).toBe(0)
  })
})

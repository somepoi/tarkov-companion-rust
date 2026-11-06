import { describe, expect, it } from 'vitest'
import { anchorStyle, boxIds, boxPlace, clampPos, cleanBoxes, hangX, nudgeInto, openSide, panelSpots, shapeRects } from './boxes'

const frame = { x: 0, y: 0, width: 2560, height: 1400 }

describe('openSide', () => {
  it('opens away from the near screen edges', () => {
    expect(openSide({ x: 16, y: 16 }, frame)).toEqual({ left: false, up: false })
    expect(openSide({ x: 2400, y: 1300 }, frame)).toEqual({ left: true, up: true })
  })
})

describe('anchorStyle', () => {
  it('hangs off the glass, from its far corner when flipped', () => {
    expect(anchorStyle({ x: 100, y: 50 }, frame, { left: false, up: false }, 0, 52)).toEqual({ left: 100, top: 102 })
    // Glass at 2400 (48 wide): right edge 2448, so 112 px from the window's right edge.
    expect(anchorStyle({ x: 2400, y: 1300 }, frame, { left: true, up: true })).toEqual({ right: 112, bottom: 52 })
  })
  it('uses offsets inside a scaled secondary monitor with a negative origin', () => {
    const secondary = { x: -1280, y: -160, width: 1280, height: 800 }
    expect(anchorStyle({ x: -1264, y: -144 }, secondary, openSide({ x: -1264, y: -144 }, secondary))).toEqual({ left: 16, top: 16 })
  })
  it('moves further away from the glass when flipped, not back over the screen edge', () => {
    expect(anchorStyle({ x: 2400, y: 1300 }, frame, { left: true, up: true }, 300, 50)).toEqual({ right: 412, bottom: 102 })
  })
})

describe('hangX and boxPlace', () => {
  it('hangs a box off the glass on its open side, inside the window', () => {
    expect(hangX({ x: 100, y: 0 }, frame, { left: false, up: false }, 372)).toBe(100)
    expect(hangX({ x: 2186, y: 0 }, frame, { left: true, up: false }, 372)).toBe(2186 + 48 - 372)
    // A wide map from a glass in the middle is pulled back onto the screen.
    expect(hangX({ x: 1300, y: 0 }, frame, { left: false, up: false }, 1400)).toBe(2560 - 1400)
    expect(boxPlace({ x: 2186, y: 1300 }, frame, { left: true, up: true }, 500, 50)).toEqual({ left: 500, bottom: 102 })
  })
})

describe('panelSpots', () => {
  it('opens panels beside the search, on the side with room', () => {
    // Glass on the right (the owner's case): every panel goes to the left of the search column.
    const col = { left: 2234 - 372, right: 2234 }
    expect(panelSpots(col, 2560, [300, 300, 300], true)).toEqual([
      { x: 1862 - 8 - 300, dy: 0 },
      { x: 1862 - 16 - 600, dy: 0 },
      { x: 1862 - 24 - 900, dy: 0 },
    ])
    // Opens right, until the screen edge; then on the left.
    expect(panelSpots({ left: 1400, right: 1772 }, 2560, [300, 300, 300], false)).toEqual([
      { x: 1780, dy: 0 },
      { x: 2088, dy: 0 },
      { x: 1400 - 8 - 300, dy: 0 },
    ])
  })
  it('overlaps, a step apart, when neither side has room', () => {
    expect(panelSpots({ left: 100, right: 700 }, 900, [300, 300], false)).toEqual([
      { x: 600, dy: 0 },
      { x: 600, dy: 34 },
    ])
  })
})

describe('nudgeInto', () => {
  it('shifts a box back inside the window', () => {
    expect(nudgeInto({ x: 2400, y: 100, width: 300, height: 200 }, 2560, 1400)).toEqual({ x: -140, y: 0 })
    expect(nudgeInto({ x: -50, y: 1300, width: 300, height: 200 }, 2560, 1400)).toEqual({ x: 50, y: -100 })
    expect(nudgeInto({ x: 10, y: 10, width: 300, height: 200 }, 2560, 1400)).toEqual({ x: 0, y: 0 })
    expect(nudgeInto({ x: 0, y: 200, width: 300, height: 2000 }, 2560, 1400)).toEqual({ x: 0, y: -200 })
  })
})

describe('clampPos', () => {
  it('keeps the move bar on the screen and sizes in range', () => {
    expect(clampPos({ x: 5000, y: -50, w: 100, h: 99999 }, frame)).toEqual({ x: 2470, y: 0, w: 220, h: 1400 })
    expect(clampPos({ x: 300, y: 200 }, frame)).toEqual({ x: 300, y: 200 })
    // A resized box low on the screen ends at the screen's bottom.
    expect(clampPos({ x: 300, y: 1000, h: 800 }, frame)).toEqual({ x: 300, y: 1000, h: 400 })
  })
})

describe('cleanBoxes', () => {
  it('keeps sane boxes only', () => {
    expect(cleanBoxes({ card: { x: 10, y: 20, w: 400, h: 300 }, 'panel:quest#1': { x: 1, y: 2, w: 10 }, bad: { x: 'a', y: 1 }, '<script>': { x: 1, y: 1 } })).toEqual({
      card: { x: 10, y: 20, w: 400, h: 300 },
      'panel:quest#1': { x: 1, y: 2 },
    })
    expect(cleanBoxes(null)).toEqual({})
  })
})

describe('shapeRects', () => {
  it('rounds outwards, adds the shadow margin and drops what is off the window', () => {
    expect(shapeRects([{ x: 10.4, y: 20.6, width: 100, height: 40 }, { x: -50, y: -50, width: 10, height: 10 }], 2560, 1400)).toEqual([{ x: 8, y: 18, width: 105, height: 45 }])
  })
})

describe('boxIds', () => {
  it('numbers repeats of one kind', () => {
    expect(boxIds(['panel:quest', 'panel:item', 'panel:quest'])).toEqual(['panel:quest', 'panel:item', 'panel:quest#1'])
  })
})

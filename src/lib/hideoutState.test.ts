import { describe, expect, it } from 'vitest'
import type { HideoutLevel, HideoutStation } from '../api/types'
import { bonusText, hideoutSummary, stationInfo } from './hideoutState'

const RUB = '5449016a4bdc2d6f028b456f'
const lvl = (level: number, p: Partial<HideoutLevel> = {}): HideoutLevel => ({
  id: `l${level}`,
  level,
  constructionTime: 0,
  traderRequirements: [],
  stationLevelRequirements: [],
  itemRequirements: [],
  skillRequirements: [],
  bonuses: [],
  description: '',
  ...p,
})
const st = (id: string, levels: HideoutLevel[]): HideoutStation => ({ id, name: id, normalizedName: id, imageLink: null, levels })

const stations = [
  st('gen', [lvl(1), lvl(2, { stationLevelRequirements: [{ stationId: 'vents', level: 1 }] })]),
  st('vents', [lvl(1, { itemRequirements: [{ itemId: 'bolts', count: 2, foundInRaid: false }, { itemId: RUB, count: 5000, foundInRaid: false }] })]),
  st('intel', [lvl(1, { stationLevelRequirements: [{ stationId: 'gen', level: 1 }], traderRequirements: [{ traderId: 'prapor', level: 2 }] })]),
  st('stash', [lvl(1)]),
]

describe('stationInfo', () => {
  it('tells built, ready, waiting for items and locked apart', () => {
    const info = stationInfo(stations, { gen: 1, stash: 1 }, { bolts: 1 }, { prapor: 2 })
    expect(info.get('stash')?.state).toBe('max')
    // Vents: no station needed, 1 of 2 bolts (money is never counted as missing).
    expect(info.get('vents')).toMatchObject({ state: 'items', missing: [{ itemId: 'bolts', count: 2, have: 1 }] })
    // Generator 2 needs Vents 1.
    expect(info.get('gen')).toMatchObject({ state: 'locked', blockedBy: [{ stationId: 'vents', level: 1, have: 0 }] })
    // Intel: Generator 1 built and Prapor LL2: ready.
    expect(info.get('intel')?.state).toBe('ready')
  })

  it('trader loyalty locks only when it is known', () => {
    expect(stationInfo(stations, { gen: 1 }, {}, { prapor: 1 }).get('intel')).toMatchObject({ state: 'locked', traderGaps: [{ traderId: 'prapor', level: 2, have: 1 }] })
    expect(stationInfo(stations, { gen: 1 }, {}, null).get('intel')?.state).toBe('ready')
  })

  it('lists what a station unlocks that is not built yet', () => {
    const info = stationInfo(stations, { gen: 1 }, {}, null)
    expect(info.get('vents')?.unlocks).toEqual([{ stationId: 'gen', level: 2, needs: 1 }])
    expect(info.get('gen')?.unlocks).toEqual([{ stationId: 'intel', level: 1, needs: 1 }])
  })

  it('sums it up', () => {
    const s = hideoutSummary(stationInfo(stations, { gen: 1, stash: 1 }, {}, null).values())
    expect(s).toEqual({ built: 2, total: 5, ready: 1, items: 1, review: 0, locked: 1, max: 1 })
  })
})

describe('bonusText', () => {
  const b = (type: string, name: string, value: number | null, skill: string | null = null) => ({ type, name, value, skill })
  it('shows fractions as percentages and counts as numbers', () => {
    expect(bonusText(b('RagfairCommission', 'Flea Market fee', -0.3))).toBe('Flea Market fee −30%')
    expect(bonusText(b('SkillGroupLevelingBoost', 'Skill group leveling', 0.3, 'Practical'))).toBe('Skill group leveling (Practical) +30%')
    expect(bonusText(b('AdditionalSlots', 'Additional slots', 2))).toBe('Additional slots +2')
  })
  it('leaves values off unlocks, the stash and zero', () => {
    expect(bonusText(b('UnlockWeaponRepair', 'Unlocks weapon repair via repair kits', 1))).toBe('Unlocks weapon repair via repair kits')
    expect(bonusText(b('StashSize', 'Stash size', 300))).toBe('Stash size')
    expect(bonusText(b('SkillGroupLevelingBoost', 'Skill group leveling', 0, 'Combat'))).toBe('Skill group leveling (Combat)')
  })
})

describe('catalog requirements with unverified item details', () => {
  it.each([
    { itemId: 'bolts', count: null, foundInRaid: false },
    { itemId: 'bolts', count: 2, foundInRaid: null },
    { itemId: 'bolts', count: 2, foundInRaid: true },
  ])('requires review for %o even when aggregate inventory has enough', (item) => {
    const station = st('gen', [lvl(1, { itemRequirements: [item] })])
    expect(stationInfo([station], {}, { bolts: 10 }, null).get('gen')?.state).toBe('review')
  })

  it('uses known count shortages even when FIR status is unknown', () => {
    const station = st('gen', [lvl(1, { itemRequirements: [{ itemId: 'bolts', count: 2, foundInRaid: null }] })])
    expect(stationInfo([station], {}, {}, null).get('gen')?.state).toBe('items')
  })
})

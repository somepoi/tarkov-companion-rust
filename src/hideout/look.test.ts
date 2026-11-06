import { describe, expect, it } from 'vitest'
import type { HideoutLevel, HideoutStation } from '../api/types'
import { stationInfo } from '../lib/hideoutState'
import { lookLabel, lookOf, timeLeft } from './look'

const lvl = (level: number, p: Partial<HideoutLevel> = {}): HideoutLevel => ({
  id: `l${level}`,
  level,
  constructionTime: 3600,
  traderRequirements: [],
  stationLevelRequirements: [],
  itemRequirements: [],
  skillRequirements: [],
  bonuses: [],
  description: '',
  ...p,
})
const st = (id: string, levels: HideoutLevel[]): HideoutStation => ({ id, name: id, normalizedName: id, imageLink: null, levels })
const infos = stationInfo(
  [st('gen', [lvl(1), lvl(2, { stationLevelRequirements: [{ stationId: 'vents', level: 1 }] })]), st('vents', [lvl(1)])],
  { gen: 1 },
  {},
  null,
)
const names = { station: (id: string) => (id === 'vents' ? 'Vents' : id), trader: () => 'Prapor' }

describe('lookOf', () => {
  const vents = infos.get('vents')!
  it('shows a timer only for the next level', () => {
    expect(lookOf(vents, { level: 1, startedAt: 0, endsAt: 1000, label: '' }, 500)).toBe('building')
    expect(lookOf(vents, { level: 1, startedAt: 0, endsAt: 1000, label: '' }, 1000)).toBe('done')
    expect(lookOf(vents, { level: 2, startedAt: 0, endsAt: 1000, label: '' }, 500)).toBe('ready')
  })
  it('names the missing station of a locked one', () => {
    const gen = infos.get('gen')!
    expect(lookLabel(lookOf(gen, undefined, 0), gen, names)).toBe('Needs Vents 1')
  })
})

describe('timeLeft', () => {
  it('reads like the game', () => {
    expect(timeLeft(0)).toBe('done')
    expect(timeLeft(45_000)).toBe('45s')
    expect(timeLeft(185_000)).toBe('3m 05s')
    expect(timeLeft(4 * 3_600_000 + 12 * 60_000)).toBe('4h 12m')
    expect(timeLeft(52 * 3_600_000)).toBe('2d 4h')
  })
})

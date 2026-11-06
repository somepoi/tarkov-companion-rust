import { expect, it } from 'vitest'
import { countedNeed, type ItemNeed } from './needs'

const need: ItemNeed = {
  itemId: 'bolts', fir: 3, nonFir: 5, unknownFir: 2, quantityUnknown: true, total: 10, alternatives: [],
  sources: [
    { kind: 'quest', id: 'fir', name: 'Quest', traderId: 't', traderName: 'Mechanic', count: 3, fir: true },
    { kind: 'hideout', id: 'any', name: 'Workbench level 2', stationId: 's', level: 2, count: 4, fir: false },
    { kind: 'craft', id: 'craft', name: 'Craft', stationId: 's', count: 1 },
    { kind: 'quest', id: 'unknown', name: 'Quest', traderId: 't', traderName: 'Mechanic', count: 2, fir: null },
    { kind: 'quest', id: 'quantity', name: 'Quest', traderId: 't', traderName: 'Mechanic', count: null, fir: true },
  ],
}

it('filters known need counts and keeps uncertain requirements visible for review', () => {
  expect(countedNeed(need, 'all')).toEqual({ total: 10, sources: need.sources, review: true })
  expect(countedNeed(need, 'fir')).toEqual({ total: 3, sources: [need.sources[0], need.sources[3], need.sources[4]], review: true })
  expect(countedNeed(need, 'any')).toEqual({ total: 5, sources: need.sources.slice(1, 4), review: true })
})

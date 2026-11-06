import { describe, expect, it } from 'vitest'
import type { Item, ItemsById } from '../api/types'
import type { ItemNeed } from '../lib/needs'
import type { Detection } from './core'
import { keptKind, type KeepKind } from './keepKinds'
import { confidence, groupDetections, needLookup, sortSell, stashValues } from './stashValues'

const det = (itemId: string, error: number, next = error + 10, extra: Partial<Detection> = {}): Detection =>
  ({ itemId, error, col: 0, row: 0, w: 1, h: 1, alternatives: [{ itemId: 'other', error: next }], ...extra }) as Detection

const item = (id: string, w = 1, h = 1): Item => ({ id, name: id.toUpperCase(), shortName: id, width: w, height: h }) as Item
const items: ItemsById = { gpu: item('gpu', 2, 1), bolts: item('bolts'), screws: item('screws'), tape: item('tape'), tape2: item('tape2') }
// Flat prices for the tests: 1000 ₽ each, the stack counted as count × 1000.
const PRICES: Record<string, number> = { gpu: 200000, bolts: 15000, screws: 9000, tape: 20000, tape2: 21000 }
const price = (it: Item | undefined, count: number) => ({ total: (PRICES[it?.id ?? ''] ?? 0) * count, via: 'flea' as const })

const need = (itemId: string, total: number, alternatives: string[] = [], fir = false): ItemNeed => ({
  itemId,
  unknownFir: 0,
  quantityUnknown: false,
  fir: fir ? total : 0,
  nonFir: fir ? 0 : total,
  total,
  sources: [{ kind: 'quest', id: 'q', name: 'Gunsmith', traderId: 'm', traderName: 'Mechanic', count: total, fir }],
  alternatives,
})

describe('groupDetections', () => {
  it('counts each item and takes the weakest match for how sure it is', () => {
    const found = groupDetections([det('bolts', 8), det('bolts', 15), det('gpu', 25), det('', 99)])
    expect(found).toEqual([
      { itemId: 'bolts', count: 2, spots: [0, 1], confidence: 'likely' },
      { itemId: 'gpu', count: 1, spots: [2], confidence: 'check' },
    ])
  })

  it('a read name makes a match surer', () => {
    expect(confidence(19, 0, true)).toBe('sure')
    expect(confidence(11, 1)).toBe('likely')
  })
})

describe('stashValues', () => {
  it('keeps what you still need and sells the rest, priciest first', () => {
    const needFor = needLookup([need('bolts', 3, [], true)], { bolts: 1 })
    const found = groupDetections([det('bolts', 5), det('bolts', 5), det('bolts', 5), det('gpu', 5), det('screws', 5)])
    const v = stashValues(found, needFor, items, price)
    // 3 needed, 1 already collected: keep 2, sell 1.
    expect(v.keep).toEqual([{ itemId: 'bolts', count: 2, need: needFor.get('bolts'), fir: true, confidence: 'sure' }])
    expect(v.sell.map((l) => [l.itemId, l.count, l.total])).toEqual([
      ['gpu', 1, 200000],
      ['bolts', 1, 15000],
      ['screws', 1, 9000],
    ])
    expect(v.total).toBe(224000)
    expect(v.sell[0].perSlot).toBe(100000)
  })

  it('items a quest accepts in place of each other share one need', () => {
    const needFor = needLookup([need('tape', 2, ['tape2'])], {})
    const found = groupDetections([det('tape', 5), det('tape2', 5), det('tape2', 5)])
    const v = stashValues(found, needFor, items, price)
    expect(v.keep.map((k) => [k.itemId, k.count])).toEqual([
      ['tape', 1],
      ['tape2', 1],
    ])
    expect(v.sell.map((l) => [l.itemId, l.count])).toEqual([['tape2', 1]])
  })

  it('a doubtful find is the one marked spare when a sure one covers the need', () => {
    const needFor = needLookup([need('tape', 1, ['tape2'])], {})
    const found = groupDetections([det('tape2', 25), det('tape', 5)])
    const v = stashValues(found, needFor, items, price)
    expect(v.keep.map((k) => k.itemId)).toEqual(['tape'])
    expect(v.sell.map((l) => [l.itemId, l.confidence])).toEqual([['tape2', 'check']])
  })

  it('sorts by stack, each or per slot', () => {
    const lines = [
      { itemId: 'gpu', count: 1, each: 200000, total: 200000, perSlot: 100000, via: 'flea' as const, confidence: 'sure' as const },
      { itemId: 'bolts', count: 20, each: 15000, total: 300000, perSlot: 15000, via: 'flea' as const, confidence: 'sure' as const },
    ]
    expect(sortSell(lines, 'total').map((l) => l.itemId)).toEqual(['bolts', 'gpu'])
    expect(sortSell(lines, 'each').map((l) => l.itemId)).toEqual(['gpu', 'bolts'])
    expect(sortSell(lines, 'slot').map((l) => l.itemId)).toEqual(['gpu', 'bolts'])
  })
})

describe('what to keep', () => {
  const both: ItemNeed = {
    itemId: 'bolts',
    unknownFir: 0,
    quantityUnknown: false,
    fir: 0,
    nonFir: 5,
    total: 5,
    sources: [
      { kind: 'quest', id: 'q', name: 'Gunsmith', traderId: 'm', traderName: 'Mechanic', count: 3, fir: false },
      { kind: 'hideout', id: 'h', name: 'Workbench', stationId: 'w', level: 2, count: 2, fir: false },
    ],
    alternatives: [],
  }
  const collector: ItemNeed = { ...need('gpu', 1), sources: [{ kind: 'quest', id: 'c', name: 'Collector', traderId: 'f', traderName: 'Fence', count: 1, fir: true }] }

  it('counts only the ticked needs', () => {
    const kinds = (k: KeepKind[]) => new Set<KeepKind>(k)
    expect(needLookup([both], { bolts: 1 }).get('bolts')?.remaining).toBe(4)
    expect(needLookup([both], { bolts: 1 }, kinds(['hideout'])).get('bolts')).toMatchObject({ remaining: 1, total: 2 })
    expect(needLookup([both], {}, kinds(['collector'])).has('bolts')).toBe(false)
    expect(needLookup([collector], {}, kinds(['quest'])).has('gpu')).toBe(false)
    expect(needLookup([collector], {}, kinds(['collector'])).has('gpu')).toBe(true)
  })

  it('keeps every item of a ticked kind, and only needs otherwise', () => {
    const typed: ItemsById = { ...items, key: { ...item('key'), types: ['keys'] } as Item, gpu: { ...items.gpu, types: ['barter'] } as Item }
    const kinds = new Set<KeepKind>(['quest', 'keys'])
    const found = [
      { itemId: 'key', count: 2, spots: [0, 1], confidence: 'sure' as const },
      { itemId: 'gpu', count: 1, spots: [2], confidence: 'sure' as const },
    ]
    const v = stashValues(found, new Map(), typed, price, (it) => keptKind(it, kinds))
    expect(v.keep).toEqual([{ itemId: 'key', count: 2, kind: 'keys', fir: false, confidence: 'sure' }])
    expect(v.sell.map((l) => l.itemId)).toEqual(['gpu'])
    expect(keptKind(typed.gpu, new Set<KeepKind>(['starred']), new Set(['gpu']))).toBe('starred')
    expect(keptKind(typed.gpu, new Set<KeepKind>(['keys']))).toBeNull()
  })
})

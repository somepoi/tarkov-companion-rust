import { describe, expect, it } from 'vitest'
import { parseSpots } from '../store/hideoutSpots'
import { parseTimers } from '../store/hideoutTimers'

describe('hideout persistence', () => {
  it('ignores reserved names and non-finite or out-of-range coordinates', () => {
    const spots = JSON.parse('{"__proto__":[1,2],"constructor":[1,2],"prototype":[1,2],"bad":[1e400,2],"far":[1000,2],"valid":[1,2]}')
    expect(parseSpots(spots)).toEqual({ valid: [1, 2] })
  })

  it('retains valid timers while ignoring reserved names and invalid durations', () => {
    const timer = { level: 1, startedAt: 100, endsAt: 200, label: 'Generator level 1' }
    const reserved = JSON.parse('{"__proto__":{},"constructor":{},"prototype":{}}') as Record<string, unknown>
    const saved = {
      regular: {
        ...Object.fromEntries(Object.keys(reserved).map((key) => [key, timer])),
        valid: timer,
        nonfinite: { ...timer, endsAt: Infinity },
        reverse: { ...timer, endsAt: 99 },
        fractional: { ...timer, level: 0.5 },
      },
      pve: [timer],
    }
    expect(parseTimers(saved)).toEqual({ regular: { valid: { ...timer, notified: false } }, pve: {} })
  })
})

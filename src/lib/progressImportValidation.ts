/** Validate legacy progress sections before any store is changed. */
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const fail = (path: string): never => { throw new Error(`Invalid progress data: ${path}`) }
const record = (v: unknown, path: string): Record<string, unknown> => {
  if (!object(v)) return fail(path)
  for (const key of Object.keys(v)) if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(path)
  return v
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const nonnegative = (v: unknown): v is number => finite(v) && v >= 0
const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string')
const coordinate = (v: unknown) => Array.isArray(v) && v.length === 2 && v.every(finite)
const modes = (value: unknown, path: string, validate: (v: unknown, path: string) => void) => {
  const byMode = record(value, path)
  for (const mode of ['regular', 'pve']) if (byMode[mode] !== undefined) validate(byMode[mode], `${path}.${mode}`)
}

export function validateProgressSections(p: Record<string, unknown>): void {
  if (p.inventory !== undefined) modes(p.inventory, 'inventory', (v, path) => {
    const inventory = record(v, path)
    for (const [field, values] of Object.entries(inventory)) {
      if (field === 'ownedKeyIds') { if (!strings(values)) fail(`${path}.${field}`); continue }
      if (!['collected', 'stationLevels', 'traderLevels'].includes(field)) fail(`${path}.${field}`)
      for (const [id, count] of Object.entries(record(values, `${path}.${field}`))) {
        if (!Number.isSafeInteger(count) || !nonnegative(count)
          || (field === 'traderLevels' && count > 4)) fail(`${path}.${field}.${id}`)
      }
    }
  })
  if (p.drawings !== undefined) for (const [key, list] of Object.entries(record(p.drawings, 'drawings'))) {
    if (!Array.isArray(list)) fail(`drawings.${key}`)
    for (const raw of list as unknown[]) {
      const d = record(raw, `drawings.${key}`)
      if (typeof d.id !== 'string' || typeof d.color !== 'string' || !nonnegative(d.weight)) fail(`drawings.${key}`)
      const shape = record(d.shape, `drawings.${key}.shape`)
      if (['marker', 'text', 'circle'].includes(String(shape.type))) {
        if (!coordinate(shape.latlng)) fail(`drawings.${key}.latlng`)
        if (shape.type === 'text' && typeof shape.text !== 'string') fail(`drawings.${key}.text`)
        if (shape.type === 'circle' && !nonnegative(shape.radius)) fail(`drawings.${key}.radius`)
      } else if (['polyline', 'polygon', 'rectangle'].includes(String(shape.type))) {
        if (!Array.isArray(shape.latlngs) || !shape.latlngs.every(coordinate)) fail(`drawings.${key}.latlngs`)
      } else fail(`drawings.${key}.shape.type`)
    }
  }
  if (p.story !== undefined) modes(p.story, 'story', (v, path) => {
    for (const [key, raw] of Object.entries(record(v, path))) {
      const chapter = record(raw, `${path}.${key}`)
      if (chapter.path !== undefined && typeof chapter.path !== 'string') fail(`${path}.${key}.path`)
      if (chapter.done !== undefined) for (const stamp of Object.values(record(chapter.done, `${path}.${key}.done`))) {
        if (!nonnegative(stamp)) fail(`${path}.${key}.done`)
      }
      if (chapter.timers !== undefined) for (const rawTimer of Object.values(record(chapter.timers, `${path}.${key}.timers`))) {
        const timer = record(rawTimer, `${path}.${key}.timer`)
        if (!nonnegative(timer.startedAt) || !nonnegative(timer.minH) || !nonnegative(timer.maxH)
          || timer.minH > timer.maxH || typeof timer.label !== 'string'
          || (timer.notified !== undefined && typeof timer.notified !== 'boolean')) fail(`${path}.${key}.timer`)
      }
    }
  })
  if (p.raidLog !== undefined) modes(p.raidLog, 'raidLog', (v, path) => {
    for (const raw of Object.values(record(v, path))) {
      const entry = record(raw, path)
      if ((entry.result !== undefined && !['survived', 'died', 'mia', 'runthrough'].includes(String(entry.result)))
        || (entry.role !== undefined && !['pmc', 'scav'].includes(String(entry.role)))
        || (entry.note !== undefined && typeof entry.note !== 'string')) fail(path)
    }
  })
  if (p.raidLogManual !== undefined) modes(p.raidLogManual, 'raidLogManual', (v, path) => {
    if (!Array.isArray(v)) fail(path)
    const keys = new Set<string>()
    for (const raw of v as unknown[]) {
      const raid = record(raw, path)
      if (typeof raid.key !== 'string' || keys.has(raid.key) || typeof raid.location !== 'string'
        || !nonnegative(raid.at) || (raid.minutes !== null && !nonnegative(raid.minutes))) fail(path)
      keys.add(raid.key as string)
    }
  })
  if (p.raidLogHidden !== undefined) modes(p.raidLogHidden, 'raidLogHidden', (v, path) => { if (!strings(v)) fail(path) })
  if (p.raidLog === undefined && (p.raidLogManual !== undefined || p.raidLogHidden !== undefined)) fail('raidLog is missing')
}

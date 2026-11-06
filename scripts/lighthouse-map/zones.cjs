// Quest zones on Lighthouse from json.tarkov.dev (exact game outlines, often a room or a building),
// in drawing units, as a specs file for trace.cjs ({ zones: [{ p, n }] }).
// Usage: zones.cjs <out.json>
const fs = require('fs')
const F = require('./frames.cjs')

;(async () => {
  const [out] = process.argv.slice(2)
  const maps = await (await fetch('https://json.tarkov.dev/pve/maps')).json()
  const lh = Object.values(maps.data.maps).find((m) => m.normalizedName === 'lighthouse')
  const tasks = await (await fetch('https://json.tarkov.dev/pve/tasks')).json()
  const en = await (await fetch('https://json.tarkov.dev/pve/tasks_en')).json()
  const tr = (k) => en.data?.[k] ?? en[k] ?? k
  const zones = []
  const seen = new Set()
  for (const t of Object.values(tasks.data.tasks)) {
    for (const o of t.objectives ?? []) {
      for (const z of o.zones ?? []) {
        if ((z.map?.id ?? z.map) !== lh.id || !(z.outline ?? []).length) continue
        const key = z.outline.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(';')
        if (seen.has(key)) continue
        seen.add(key)
        zones.push({ p: z.outline.map((p) => F.gameToSvg(p.x, p.z).map((n) => +n.toFixed(2))), n: String(tr(t.name)).slice(0, 40), y: [z.bottom, z.top] })
      }
    }
  }
  fs.writeFileSync(out, JSON.stringify({ zones }))
  console.log(zones.length, 'zones')
  for (const z of zones) {
    const us = z.p.map((p) => p[0])
    const vs = z.p.map((p) => p[1])
    console.log(`${z.n.padEnd(40)} u ${Math.min(...us).toFixed(0)}–${Math.max(...us).toFixed(0)} v ${Math.min(...vs).toFixed(0)}–${Math.max(...vs).toFixed(0)}`)
  }
})().catch((e) => console.log('FAILED', e.message))

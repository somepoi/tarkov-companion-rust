// Audits the game logs for the Stats tab: profiles per mode over time and raid start/end counts.
// Usage: npx tsx scripts/raid-audit.ts [logsFolder]
import { LogWatcher } from './logs/watcher'
import { detectLogsFolder } from './logs/locator'

const logs = process.argv[2] ?? detectLogsFolder().path
if (!logs) throw new Error('No logs folder found')
const w = new LogWatcher()
w.configure({ logsPath: logs, detectedPath: logs, paused: true })
const r = w.backfill()
const ev = [...r.events].sort((a, b) => a.at - b.at)
const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')
console.log('folders', r.folders, 'current profile per mode', r.currentProfileByMode)
let last = ''
for (const e of ev) {
  if (e.kind !== 'profile') continue
  const k = `${e.mode}:${e.profileId}`
  if (k !== last) console.log(day(e.at), e.mode.padEnd(8), e.profileId, 'account', e.accountId)
  last = k
}
const count = (kind: string, mode: string) => ev.filter((e) => e.kind === kind && e.mode === mode).length
for (const mode of ['pve', 'regular', 'unknown']) {
  console.log(mode, 'matched', count('raidMatched', mode), 'started', count('raidStarted', mode), 'ended', count('raidEnded', mode), 'aborted', count('matchingAborted', mode))
}

// Reset fingerprint: a quest handed in earlier is started again.
const finishedAt = new Map<string, number>()
const restarts: { at: number; taskId: string }[] = []
for (const e of ev) {
  if (e.mode !== 'pve') continue
  if (e.kind === 'taskFinished') finishedAt.set(e.taskId, e.at)
  if (e.kind === 'taskStarted' && finishedAt.has(e.taskId)) restarts.push({ at: e.at, taskId: e.taskId })
}
console.log('restarted after being handed in:', restarts.length)
for (const r of restarts.slice(0, 12)) console.log('  ', day(r.at), r.taskId, 'finished before', day(finishedAt.get(r.taskId)!))
// Raids per day (matched) to see the gap / reset
const perDay = new Map<string, number[]>()
for (const e of ev) {
  if (e.mode !== 'pve') continue
  const d = day(e.at).slice(0, 10)
  const v = perDay.get(d) ?? [0, 0, 0]
  if (e.kind === 'raidMatched') v[0]++
  if (e.kind === 'raidStarted') v[1]++
  if (e.kind === 'raidEnded') v[2]++
  perDay.set(d, v)
}
for (const [d, v] of perDay) console.log(d, 'matched', v[0], 'started', v[1], 'ended', v[2])

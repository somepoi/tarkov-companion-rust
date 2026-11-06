// Prints what the Stats tab computes from the real logs (PvE): raids since the reset and in total.
import { LogWatcher } from './logs/watcher'
import { detectLogsFolder } from './logs/locator'
import { computeLogStats } from '../src/lib/logStats'
const logs = detectLogsFolder().path as string
const w = new LogWatcher()
w.configure({ logsPath: logs, detectedPath: logs, paused: true })
const r = w.backfill()
const data = { events: r.events, sessions: r.sessions ?? [], accountId: null, from: null, to: null, resetAtByMode: r.resetAtByMode! }
const reset = data.resetAtByMode.pve
console.log('PvE reset detected at', reset ? new Date(reset).toString() : 'none')
const since = computeLogStats(data, 'pve', null, 30)
const all = computeLogStats(data, 'pve', null, 30, Date.now(), true)
console.log('raids since reset', since.raids.length, '(with length', since.raids.filter((x) => x.minutes !== null).length + ')', '| all logs', all.raids.length)
console.log('by map since reset', since.byMap.map((m) => `${m.location.replace(/^maps\//, '')} ${m.raids}`).join(', '))
console.log('quests handed in since reset', since.questsFinished, '| finished ticks offered by Read past logs', r.finishedByMode.pve.length)
console.log('flea income since reset', since.income.RUB, 'sales', since.fleaSales)

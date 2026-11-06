// Scans an EFT Logs folder with the same code the desktop app uses and prints
// what a "Read past logs" backfill would find. Read-only.
// Usage: npx tsx scripts/scan-logs.ts [path-to-Logs-folder]
import { detectLogsFolder } from './logs/locator'
import { LogWatcher } from './logs/watcher'

const arg = process.argv[2]
const detection = detectLogsFolder()
const logsPath = arg ?? detection.path
if (!logsPath) {
  console.error('No logs folder found. Candidates checked:\n  ' + detection.candidates.join('\n  '))
  process.exit(1)
}
console.log(`Logs folder: ${logsPath}${arg ? '' : ' (auto-detected)'}`)

const watcher = new LogWatcher()
watcher.configure({ logsPath, detectedPath: detection.path, paused: true })
const result = watcher.backfill()
watcher.stop()

const counts: Record<string, number> = {}
for (const e of result.events) counts[e.kind] = (counts[e.kind] ?? 0) + 1
console.log(`Session folders: ${result.folders}, files read: ${result.files}, events: ${result.events.length}`)
console.log('Events by kind:', counts)
for (const mode of ['regular', 'pve', 'seasonal', 'unknown'] as const) {
  console.log(`Distinct finished tasks (${mode}): ${result.finishedByMode[mode].length}`)
}
const started = new Set(result.events.filter((e) => e.kind === 'taskStarted').map((e) => (e as { taskId: string }).taskId))
const failed = new Set(result.events.filter((e) => e.kind === 'taskFailed').map((e) => (e as { taskId: string }).taskId))
console.log(`Distinct started tasks: ${started.size}, distinct failed tasks: ${failed.size}`)
const modes = result.events.filter((e) => e.kind === 'sessionMode').map((e) => (e as { raw: string }).raw)
console.log('Session mode lines seen:', [...new Set(modes)].join(', ') || 'none')

import { LogWatcher } from './logs/watcher'
import { detectLogsFolder } from './logs/locator'
const w = new LogWatcher()
const logs = detectLogsFolder().path as string
w.configure({ logsPath: logs, detectedPath: logs, paused: true })
const ev = w.backfill().events.filter((e) => ['raidMatched', 'raidStarting', 'raidStarted', 'raidEnded', 'matchingAborted', 'mapLoading'].includes(e.kind)).sort((a, b) => a.at - b.at)
const day = process.argv[2] ?? '2026-10-02'
for (const e of ev) {
  const t = new Date(e.at)
  const d = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  if (d !== day) continue
  const extra = e.kind === 'raidMatched' ? `${e.location} online=${e.online} ${e.gameMode} ${e.raidId}` : e.kind === 'raidEnded' ? `${e.location} ${e.raidId}` : e.kind === 'mapLoading' ? e.scenePath : ''
  console.log(t.toTimeString().slice(0, 8), e.kind.padEnd(16), extra, e.source.file.slice(-28))
}

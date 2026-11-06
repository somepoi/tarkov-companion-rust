// Lists every quest-related chat notification in the EFT logs with the raw
// templateId, the resolved quest name and the game mode, so mismatches between
// what the log says and what the app marks can be audited. Read-only.
// Usage: npx tsx scripts/audit-quest-messages.ts [path-to-Logs-folder]
import fs from 'node:fs'
import path from 'node:path'
import { detectLogsFolder } from './logs/locator'

const logsPath = process.argv[2] ?? detectLogsFolder().path
if (!logsPath) throw new Error('no logs folder')

const tasksRes = (await (await fetch('https://json.tarkov.dev/pve/tasks')).json()) as { data: { tasks: Record<string, { id: string; name: string }> } }
const enRes = (await (await fetch('https://json.tarkov.dev/pve/tasks_en')).json()) as { data?: Record<string, string> } & Record<string, string>
const en: Record<string, string> = (enRes.data ?? enRes) as Record<string, string>
const tasks: Record<string, { name: string; id: string }> = {}
for (const t of Object.values(tasksRes.data.tasks) as { id: string; name: string }[]) tasks[t.id] = { id: t.id, name: en[t.name] ?? t.name }

type Row = { at: string; type: number; templateId: string; name: string; text?: string; hasItems: boolean; folder: string }
const rows: Row[] = []
for (const folder of fs.readdirSync(logsPath).sort()) {
  const dir = path.join(logsPath, folder)
  if (!fs.statSync(dir).isDirectory()) continue
  for (const file of fs.readdirSync(dir)) {
    if (!/push-notifications|notifications\.log/i.test(file)) continue
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('ChatMessageReceived')) continue
      const at = lines[i].slice(0, 19)
      let j = i + 1
      const buf: string[] = []
      while (j < lines.length && !/^\d{4}-\d\d-\d\d /.test(lines[j])) buf.push(lines[j++])
      try {
        const json = JSON.parse(buf.join('\n'))
        const msg = json.message ?? json
        if (![10, 11, 12].includes(msg.type)) continue
        const tid = String(msg.templateId ?? '')
        const first = tid.split(' ')[0]
        rows.push({ at, type: msg.type, templateId: tid, name: tasks[first]?.name ?? '(not a task id)', text: msg.text, hasItems: Boolean(msg.items || msg.hasRewards), folder })
      } catch {
        // not JSON
      }
    }
  }
}
const label = { 10: 'STARTED ', 11: 'FAILED  ', 12: 'FINISHED' } as Record<number, string>
for (const r of rows) console.log(r.at, label[r.type], r.name.padEnd(42), r.templateId)
const suffixes: Record<string, number> = {}
for (const r of rows) {
  const s = `${r.type} ${r.templateId.split(' ').slice(1).join(' ')}`
  suffixes[s] = (suffixes[s] ?? 0) + 1
}
console.log('\ntemplateId suffix counts by type:', suffixes)

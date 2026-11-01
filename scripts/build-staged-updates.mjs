// Explicit local signed staging build; no publishing or installer execution.
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

try {
  if (process.argv.length !== 2) throw new Error('Staged build accepts no extra arguments; use the documented environment variables.')
  for (const name of ['TC_STAGED_UPDATE_ENDPOINT', 'TC_STAGED_UPDATE_PUBLIC_KEY', 'TAURI_SIGNING_PRIVATE_KEY']) {
    if (!process.env[name]?.trim()) throw new Error(`Missing ${name}. Supply signing material locally; never commit it.`)
  }
  const npm = process.env.npm_execpath
  if (!npm || !fs.existsSync(npm)) throw new Error('Run this through npm run build:tauri:staged.')
  const result = spawnSync(process.execPath, [npm, 'run', 'build:tauri', '--', '--features', 'staged-updates', '--config', 'src-tauri/tauri.updater.conf.json', '--bundles', 'nsis', '--ci'], {
    env: { ...process.env, VITE_STAGED_UPDATES: '1' }, stdio: 'inherit', windowsHide: true, shell: false,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

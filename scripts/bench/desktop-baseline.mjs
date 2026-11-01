/** Measurement-only Windows process-tree sampler. Never deletes profiles or terminates apps. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const usage = `Usage: node scripts/bench/desktop-baseline.mjs --exe ABSOLUTE.exe --isolation-contract HOST_CONTRACT_DESCRIPTION [--profile-env HOST_PROFILE_VARIABLE] --arg TOKEN_WITH_{profile} [--duration 300] [--settle 30] [--sample-ms 1000] [--label foreground|hidden|other]
The named executable must implement the supplied profile argument/environment override and disable
autostart/updater/cleanup/real game integration in that isolated mode. This sampler cannot
verify that contract. It creates a fresh temporary profile, records child-process metrics,
does not touch game processes, and leaves the launched application running when finished.`
const values = new Map()
const launchArgs = []
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (key === '--help') { console.log(usage); process.exit(0) }
  if (!['--exe', '--profile-env', '--isolation-contract', '--arg', '--duration', '--settle', '--sample-ms', '--label'].includes(key)) throw new Error(`Unknown option: ${key}`)
  const value = process.argv[++i]
  if (value === undefined) throw new Error(`Missing value for ${key}`)
  if (key === '--arg') launchArgs.push(value)
  else if (values.has(key)) throw new Error(`Duplicate option: ${key}`)
  else values.set(key, value)
}
if (process.platform !== 'win32') throw new Error('Windows is required for this resource sampler')
const exe = values.get('--exe')
const profileEnv = values.get('--profile-env')
const contract = values.get('--isolation-contract')
if (!exe || !path.isAbsolute(exe) || !fs.statSync(exe).isFile() || path.extname(exe).toLowerCase() !== '.exe') throw new Error(usage)
if (profileEnv && (!/^[A-Z][A-Z0-9_]{2,80}$/.test(profileEnv) || /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|SYSTEMROOT|COMSPEC|CODEX_HOME)$/.test(profileEnv))) throw new Error('Supply a host-specific --profile-env, not a system variable')
if (!profileEnv && !launchArgs.some((arg) => arg.includes('{profile}'))) throw new Error('Supply a supported --arg containing {profile}, or a host-specific --profile-env')
if (!contract || contract.trim().length < 15) throw new Error('Describe the verified host isolation contract using --isolation-contract')
if (/^(?:EscapeFromTarkov|EscapeFromTarkov_BE|BsgLauncher|BEService)(?:[._-]|$)/i.test(path.basename(exe))) throw new Error('This tool never launches game, launcher or protection executables')
const number = (key, fallback, min, max) => {
  const n = Number(values.get(key) ?? fallback)
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be in ${min}..${max}`)
  return n
}
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-desktop-baseline-'))
const profile = path.join(out, 'profile')
fs.mkdirSync(profile)
const readyFile = path.join(out, 'ready.json')
const catalogReadyFile = path.join(out, 'catalog-ready.json')
const config = {
  schema: 1, executable: fs.realpathSync(exe),
  executableSha256: crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex'),
  profile, profileEnv: profileEnv ?? null, isolationContract: contract, readyFile, catalogReadyFile,
  arguments: launchArgs.map((arg) => arg.replaceAll('{profile}', profile)),
  durationSeconds: number('--duration', 300, 1, 86400),
  settleSeconds: number('--settle', 30, 0, 3600),
  sampleMs: number('--sample-ms', 1000, 250, 60000),
  workloadLabel: values.get('--label') ?? 'unspecified',
  output: path.join(out, 'desktop.json'),
}
const configFile = path.join(out, 'launch.json')
fs.writeFileSync(configFile, JSON.stringify(config, null, 2), { flag: 'wx' })
console.log(`Fresh measurement directory: ${out}`)
const script = fileURLToPath(new URL('./measure-desktop.ps1', import.meta.url))
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-ConfigFile', configFile], { windowsHide: true, stdio: 'inherit' })
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code) => { process.exitCode = code ?? 1; console.log(`Measurement output: ${config.output}; the application is not terminated by this tool.`) })

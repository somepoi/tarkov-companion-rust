import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Claim only an empty profile created by the measurement launcher. No cleanup. */
export function claimBenchmarkProfile(profile: string): void {
  if (!path.isAbsolute(profile) || !fs.lstatSync(profile).isDirectory()) throw new Error('Benchmark profile must be an existing absolute directory')
  const canonical = fs.realpathSync.native(profile)
  const root = path.dirname(canonical)
  if (path.basename(canonical) !== 'profile' || !/^tc-desktop-baseline-[a-z0-9]+$/i.test(path.basename(root))
    || path.dirname(root).toLowerCase() !== fs.realpathSync.native(os.tmpdir()).toLowerCase()) throw new Error('Benchmark profile must belong to a fresh measurement directory')
  const launch = path.join(root, 'launch.json')
  if (!fs.lstatSync(launch).isFile()) throw new Error('Missing regular measurement launch record')
  const fd = fs.openSync(launch, 'r')
  const bytes = Buffer.alloc(64 * 1024 + 1)
  let count = 0
  try {
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null)
      if (!n) break
      count += n
    }
  } finally { fs.closeSync(fd) }
  if (count > 64 * 1024) throw new Error('Measurement launch record is too large')
  const config = JSON.parse(bytes.subarray(0, count).toString('utf8')) as { profile?: unknown; executable?: unknown }
  if (typeof config.profile !== 'string' || typeof config.executable !== 'string'
    || fs.realpathSync.native(config.profile).toLowerCase() !== canonical.toLowerCase()
    || fs.realpathSync.native(config.executable).toLowerCase() !== fs.realpathSync.native(process.execPath).toLowerCase()) throw new Error('Measurement launch record does not match this process/profile')
  if (fs.readdirSync(canonical).length) throw new Error('Benchmark profile is not fresh; create a new measurement directory')
  fs.writeFileSync(path.join(canonical, '.benchmark-owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', flush: true })
}

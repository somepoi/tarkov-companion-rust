import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function fromPath(command, env) {
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) return fs.existsSync(command) ? path.resolve(command) : null
  const key = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  for (const directory of (env[key] ?? '').split(path.delimiter)) {
    if (!directory) continue
    const file = path.join(directory, process.platform === 'win32' && !path.extname(command) ? `${command}.exe` : command)
    if (fs.existsSync(file)) return file
  }
  return null
}

export function nativeToolchain(base = process.env) {
  const env = { ...base }
  const cargo = base.CARGO ? fromPath(base.CARGO, base) : fromPath('cargo', base) ?? fromPath(path.join(base.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo'), base)
  if (!cargo) throw new Error('Cargo was not found. Install Rust with rustup, or set CARGO to its executable path.')
  const key = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  env[key] = `${path.dirname(cargo)}${path.delimiter}${env[key] ?? ''}`
  env.CARGO = cargo
  return { cargo, env }
}

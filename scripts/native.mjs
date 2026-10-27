import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { nativeToolchain } from './lib/native-toolchain.mjs'

try {
  const [tool, ...args] = process.argv.slice(2)
  const { cargo, env } = nativeToolchain()
  let executable = cargo
  let arguments_ = args
  if (tool === 'tauri') {
    const directory = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/', import.meta.url))
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
    executable = process.execPath
    arguments_ = [path.join(directory, pkg.bin.tauri), ...args]
  } else if (tool !== 'cargo') throw new Error('Usage: node scripts/native.mjs cargo|tauri <arguments>')
  const child = spawn(executable, arguments_, { env, stdio: 'inherit', windowsHide: true, shell: false })
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code) => { process.exitCode = code ?? 1 })
} catch (error) { console.error(error.message); process.exitCode = 1 }

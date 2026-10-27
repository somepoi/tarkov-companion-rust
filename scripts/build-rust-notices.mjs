// Collect licenses from the locked Windows dependency graph, without executing code.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { nativeToolchain } from './lib/native-toolchain.mjs'

const toolchain = nativeToolchain()
const metadata = JSON.parse(execFileSync(toolchain.cargo, [
  'metadata', '--locked', '--offline', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc',
], { env: toolchain.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true }))
const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]))
const reachable = new Set()
function visit(id) {
  if (reachable.has(id)) return
  reachable.add(id)
  for (const dependency of nodes.get(id)?.dependencies ?? []) visit(dependency)
}
for (const id of metadata.workspace_members) visit(id)
const packages = metadata.packages.filter((p) => p.source && reachable.has(p.id)).sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))
const texts = new Map()
const sections = []
const missing = []
const overrides = JSON.parse(fs.readFileSync('scripts/licenses/sources.json', 'utf8'))
for (const pkg of packages) {
  const directory = path.dirname(pkg.manifest_path)
  const files = fs.readdirSync(directory, { withFileTypes: true })
    .filter((f) => f.isFile() && /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[._-]|$)/i.test(f.name))
    .map((f) => path.join(directory, f.name))
  if (pkg.license_file) files.push(path.resolve(directory, pkg.license_file))
  const override = overrides[`${pkg.name}@${pkg.version}`]
  if (override && !files.length) {
    const vcs = JSON.parse(fs.readFileSync(path.join(directory, '.cargo_vcs_info.json'), 'utf8'))
    if (vcs.git.sha1 !== override.commit) throw new Error(`License source revision changed for ${pkg.name}`)
    for (const entry of override.files) files.push(path.join('scripts/licenses', entry.file))
  }
  const references = []
  for (const file of [...new Set(files)].sort()) {
    if (fs.statSync(file).size > 2 * 1024 * 1024) throw new Error(`Oversized license file in ${pkg.name}`)
    const text = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n').trim()
    if (!text) continue
    const hash = crypto.createHash('sha256').update(text).digest('hex')
    texts.set(hash, text)
    references.push(`${path.basename(file)}: text ${hash.slice(0, 16)}`)
  }
  if (!pkg.license || !references.length) missing.push(`${pkg.name}@${pkg.version}`)
  sections.push(`${pkg.name} ${pkg.version}`, `License expression: ${pkg.license ?? 'not declared'}`, `Authors: ${(pkg.authors ?? []).join(', ')}`, `Source: ${pkg.repository ?? pkg.homepage ?? pkg.source}`, ...(override?.files.map((entry) => `License source: ${entry.source}`) ?? []), ...references, '')
}
const output = [
  'Tarkov Companion Rust — native dependency notices',
  '',
  `Cargo.lock SHA-256 (LF): ${crypto.createHash('sha256').update(fs.readFileSync('Cargo.lock', 'utf8').replaceAll('\r\n', '\n')).digest('hex')}`,
  'Target: x86_64-pc-windows-msvc. Includes build-time dependencies from the resolved graph.',
  'Identical license texts are included once and referenced by content hash.',
  'The application remains GPL-3.0-or-later; each dependency retains its own license.',
  '', ...sections,
]
for (const [hash, text] of [...texts.entries()].sort(([a], [b]) => a.localeCompare(b))) output.push('='.repeat(78), `License text ${hash.slice(0, 16)}`, '-'.repeat(78), text, '')
fs.writeFileSync('THIRD_PARTY_NOTICES_RUST.txt', output.join('\n'))
console.log(`Native notices: ${packages.length} crates, ${texts.size} distinct license texts`)
if (missing.length) { console.error(`License review required: ${missing.join(', ')}`); process.exitCode = 1 }

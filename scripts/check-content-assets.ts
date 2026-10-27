// Distribution input validation, not a screenshot/recognition test runner.
import fs from 'node:fs'
import path from 'node:path'
import { fingerprintHeader, scannerManifest, SCANNER_FILES, MAX_FINGERPRINT_HEADER_BYTES } from '../src/scan/assets'
import { generatedPath, root, sha256 } from './lib/content-assets.mjs'
import { MODEL_SHA256, OCR_FILES } from './lib/ocr-model.mjs'

const directory = process.argv[2] ?? 'public'
if (process.argv.length > 3 || !['public', 'dist', 'dist-tauri'].includes(directory))
  throw new Error('Usage: npm run assets:check -- [public|dist|dist-tauri]')

function json(file: string, limit = 16 * 1024 * 1024): unknown {
  if (fs.statSync(file).size > limit) throw new Error(`Asset metadata too large: ${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
function checkFile(directory: string, name: string, expected: { size: number; sha256: string }) {
  const file = generatedPath(path.relative(root, path.join(directory, name)))
  if (!expected || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 256 * 1024 * 1024
    || !/^[a-f0-9]{64}$/.test(expected.sha256) || fs.statSync(file).size !== expected.size)
    throw new Error(`Missing or mismatched asset: ${name}`)
  const bytes = fs.readFileSync(file)
  if (sha256(bytes) !== expected.sha256) throw new Error(`Asset checksum differs: ${name}`)
  return bytes
}

try {
  const scan = generatedPath(`${directory}/scan`)
  const manifest = scannerManifest(json(path.join(scan, 'manifest.json'), 64 * 1024))
  if (manifest.files['fingerprints.json'].size > MAX_FINGERPRINT_HEADER_BYTES)
    throw new Error('Fingerprint header exceeds the runtime metadata budget')
  const files = Object.fromEntries(SCANNER_FILES.map((name) => [name, checkFile(scan, name, manifest.files[name])]))
  const header = fingerprintHeader(JSON.parse(files['fingerprints.json'].toString('utf8')), files['fingerprints.bin'].length)
  const ocr = generatedPath(`${directory}/ocr`)
  const metadata = json(path.join(ocr, 'manifest.json'), 64 * 1024) as {
    kind: string; version: number; language: string; model: { sha256: string };
    engine: { tesseract: string; core: string }; files: Record<string, { size: number; sha256: string }>
  }
  if (metadata?.kind !== 'tarkov-companion-ocr-assets' || metadata.version !== 1 || metadata.language !== 'eng'
    || metadata.model?.sha256 !== MODEL_SHA256 || !metadata.files || !metadata.engine)
    throw new Error('Unsupported OCR asset manifest')
  for (const name of OCR_FILES) checkFile(ocr, name, metadata.files[name])
  if (metadata.files['eng.traineddata.gz'].sha256 !== MODEL_SHA256) throw new Error('OCR model differs from its pinned checksum')
  for (const [key, module] of [['tesseract', 'tesseract.js'], ['core', 'tesseract.js-core']] as const) {
    const installed = json(path.join(root, 'node_modules', module, 'package.json')) as { version: string }
    if (metadata.engine[key] !== installed.version) throw new Error('OCR assets are stale after a dependency update; rebuild them')
  }
  if (directory !== 'public') {
    for (const kind of ['scan', 'ocr'])
      if (sha256(fs.readFileSync(generatedPath(`${directory}/${kind}/manifest.json`)))
        !== sha256(fs.readFileSync(generatedPath(`public/${kind}/manifest.json`))))
        throw new Error('Built content differs from current source assets; rebuild the frontend')
  }
  console.log(`${directory}: content assets valid, ${header.items.length} scanner references (${manifest.modes.join(', ')}), ${OCR_FILES.length} OCR files`)
} catch (error) {
  throw new Error(`Content assets are not ready. Run npm run assets:prepare before packaging. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
}

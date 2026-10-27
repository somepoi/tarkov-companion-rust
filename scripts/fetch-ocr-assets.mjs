// Prepare the incumbent offline English engine/model without partial publication.
import fs from 'node:fs'
import path from 'node:path'
import { atomicBytes, fetchBytes, fileEntries, generatedPath, newAssetStage, publishAssetStage, root, sha256 } from './lib/content-assets.mjs'
import { MODEL_URL, MODEL_SHA256 } from './lib/ocr-model.mjs'

const offline = process.argv.slice(2).includes('--offline')
if (process.argv.slice(2).some((arg) => arg !== '--offline')) throw new Error('Usage: npm run ocr:assets -- [--offline]')
const cached = generatedPath('assets-src/ocr/eng.traineddata.gz')
let model
if (fs.existsSync(cached)) {
  if (fs.statSync(cached).size > 16 * 1024 * 1024) throw new Error('Cached OCR model exceeds its size limit')
  model = fs.readFileSync(cached)
  if (sha256(model) !== MODEL_SHA256) throw new Error('Cached OCR model checksum differs; retained for diagnosis. Move it aside before rebuilding.')
} else {
  if (offline) throw new Error('Offline OCR preparation requires a cached English model')
  model = await fetchBytes(MODEL_URL, 16 * 1024 * 1024, ['cdn.jsdelivr.net'])
  if (sha256(model) !== MODEL_SHA256) throw new Error('Downloaded OCR model checksum differs; refusing to publish it')
  atomicBytes(cached, model)
}
const stage = newAssetStage('ocr')
const names = ['worker.min.js']
fs.copyFileSync(path.join(root, 'node_modules/tesseract.js/dist/worker.min.js'), path.join(stage, names[0]))
for (const variant of ['lstm', 'simd-lstm', 'relaxedsimd-lstm']) {
  const name = `tesseract-core-${variant}.wasm.js`
  fs.copyFileSync(path.join(root, 'node_modules/tesseract.js-core', name), path.join(stage, name))
  names.push(name)
}
fs.writeFileSync(path.join(stage, 'eng.traineddata.gz'), model)
names.push('eng.traineddata.gz')
const installed = (name) => JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version
const manifest = {
  kind: 'tarkov-companion-ocr-assets', version: 1, language: 'eng',
  engine: { tesseract: installed('tesseract.js'), core: installed('tesseract.js-core') },
  model: { url: MODEL_URL, sha256: MODEL_SHA256 }, files: fileEntries(stage, names),
}
fs.writeFileSync(path.join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
publishAssetStage(stage, 'ocr')
console.log(`OCR assets ready: ${names.length} files; model ${MODEL_SHA256}`)

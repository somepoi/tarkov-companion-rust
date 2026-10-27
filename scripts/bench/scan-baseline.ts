/** Offline measurement runner, not an assertion suite. Requires an operator-supplied corpus. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import sharp from 'sharp'
import { readWordsNode, closeOcr } from '../ocr-node'
import { buildCandidates, chooseGrid, indexFromParts, scanGrid, type Detection, type FingerprintHeader, type OcrWord } from '../../src/scan/core'

interface Label { itemId: string; col: number; row: number; w: number; h: number; rotated?: boolean }
interface Entry { id: string; image: string; sha256: string; stratum: string; wordsFile?: string; expected?: { complete: boolean; detections: Label[] } }
interface Corpus { schemaVersion: 1; description: string; entries: Entry[] }
interface Stages { decodeMs: number; ocrMs: number; gridMs: number; matchMs: number; totalMs: number }
interface Sample { id: string; stratum: string; phase: 'cold-worker' | 'warm-worker'; iteration: number; ok: boolean; stages?: Stages; error?: string; failureElapsedMs?: number; found?: Detection[]; agreement?: ReturnType<typeof labelAgreement>; processMemoryAfter?: NodeJS.MemoryUsage }

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]
  if (!['--manifest', '--assets', '--repeats', '--ocr', '--max-pixels'].includes(key) || args.has(key)) throw new Error(`Unknown/duplicate option: ${key}`)
  const value = process.argv[++i]
  if (value === undefined) throw new Error(`Missing value for ${key}`)
  args.set(key, value)
}
const manifestArg = args.get('--manifest')
const assetsArg = args.get('--assets')
if (!manifestArg || !assetsArg) throw new Error('Usage: npx --no-install tsx scripts/bench/scan-baseline.ts --manifest ABSOLUTE_MANIFEST.json --assets ABSOLUTE_FINGERPRINT_DIRECTORY [--repeats 10] [--ocr on|off|supplied] [--max-pixels 40000000]')
if (!path.isAbsolute(manifestArg) || !path.isAbsolute(assetsArg)) throw new Error('Manifest and assets paths must be absolute')
const manifestFile = fs.realpathSync(manifestArg)
const assets = fs.realpathSync(assetsArg)
const mode = args.get('--ocr') ?? 'on'
if (!['on', 'off', 'supplied'].includes(mode)) throw new Error('--ocr must be on, off, or supplied')
const repeats = Number(args.get('--repeats') ?? 10)
const maxPixels = Number(args.get('--max-pixels') ?? 40_000_000)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 1000 || !Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new Error('Invalid repeats or max-pixels')
const hash = (bytes: Uint8Array | string) => crypto.createHash('sha256').update(bytes).digest('hex')
const manifestBytes = fs.readFileSync(manifestFile)
const corpus = JSON.parse(manifestBytes.toString('utf8')) as Corpus
if (corpus.schemaVersion !== 1 || !Array.isArray(corpus.entries) || corpus.entries.length === 0 || typeof corpus.description !== 'string') throw new Error('Manifest must describe a nonempty schemaVersion 1 corpus')
const root = path.dirname(manifestFile)
function corpusPath(relative: string): string {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Corpus file paths must be relative')
  const resolved = fs.realpathSync(path.resolve(root, relative))
  const rel = path.relative(root, resolved)
  if (rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw new Error('Corpus file escapes the manifest directory')
  return resolved
}
const ids = new Set<string>()
const inputs = corpus.entries.map((entry) => {
  if (!entry || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id) || typeof entry.stratum !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error('Each entry needs unique id, stratum and SHA-256')
  ids.add(entry.id)
  const file = corpusPath(entry.image)
  if (hash(fs.readFileSync(file)).toLowerCase() !== entry.sha256.toLowerCase()) throw new Error(`Image hash differs from manifest: ${entry.id}`)
  if (entry.expected) {
    if (typeof entry.expected.complete !== 'boolean' || !Array.isArray(entry.expected.detections)) throw new Error(`Invalid labels: ${entry.id}`)
    for (const d of entry.expected.detections) {
      if (typeof d.itemId !== 'string' || !d.itemId || ![d.col, d.row, d.w, d.h].every(Number.isSafeInteger) || d.col < 0 || d.row < 0 || d.w < 1 || d.h < 1 || (d.rotated !== undefined && typeof d.rotated !== 'boolean')) throw new Error(`Invalid label geometry: ${entry.id}`)
    }
  }
  const wordsPath = entry.wordsFile ? corpusPath(entry.wordsFile) : null
  if (mode === 'supplied' && !wordsPath) throw new Error(`Missing wordsFile: ${entry.id}`)
  const words = wordsPath ? JSON.parse(fs.readFileSync(wordsPath, 'utf8')) as OcrWord[] : undefined
  if (words && (!Array.isArray(words) || words.some((w) => typeof w.text !== 'string' || ![w.conf, w.x0, w.y0, w.x1, w.y1].every(Number.isFinite)))) throw new Error(`Invalid supplied OCR words: ${entry.id}`)
  return { entry, file, words, wordsSha256: wordsPath ? hash(fs.readFileSync(wordsPath)) : null }
})
const ocrModelFile = path.resolve('public/ocr/eng.traineddata.gz')
if (mode === 'on' && !fs.existsSync(ocrModelFile)) throw new Error('Local public/ocr/eng.traineddata.gz required; this runner does not download assets')
const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-scan-baseline-'))
const output = path.join(outputDir, 'scan.json')
const headerFile = path.join(assets, 'fingerprints.json')
const pixelsFile = path.join(assets, 'fingerprints.bin')
const samples: Sample[] = []
const inits: { id: string; ms: number }[] = []
function labelAgreement(found: Detection[], expected: NonNullable<Entry['expected']>) {
  const used = new Set<number>()
  let exact = 0
  for (const label of expected.detections) {
    const i = found.findIndex((d, index) => !used.has(index) && d.itemId === label.itemId && d.col === label.col && d.row === label.row && d.w === label.w && d.h === label.h && (label.rotated === undefined || d.rotated === label.rotated))
    if (i >= 0) { used.add(i); exact++ }
  }
  return { labeled: expected.detections.length, exactIdentityAndBox: exact, missingOrDifferent: expected.detections.length - exact, unlabeledOrDifferentDetections: expected.complete ? found.length - exact : null, precision: expected.complete && found.length ? exact / found.length : null, recall: expected.detections.length ? exact / expected.detections.length : null, completeLabels: expected.complete, quantityAndFir: 'not produced by current scanner' }
}
function quantiles(values: number[]) {
  if (!values.length) return { count: 0, p50: null, p95: null }
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }
}
try {
  for (const input of inputs) {
    await closeOcr()
    const initAt = performance.now()
    const index = indexFromParts(JSON.parse(fs.readFileSync(headerFile, 'utf8')) as FingerprintHeader, new Uint8Array(fs.readFileSync(pixelsFile)))
    const candidates = buildCandidates(index)
    inits.push({ id: input.entry.id, ms: performance.now() - initAt })
    for (let iteration = 0; iteration <= repeats; iteration++) {
      const sample: Sample = { id: input.entry.id, stratum: input.entry.stratum, phase: iteration === 0 ? 'cold-worker' : 'warm-worker', iteration, ok: false }
      const attemptAt = performance.now()
      try {
        const start = performance.now()
        const decoded = await sharp(input.file, { limitInputPixels: maxPixels }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        const decodedAt = performance.now()
        const words = mode === 'on' ? await readWordsNode(input.file) : mode === 'supplied' ? input.words : undefined
        const ocrAt = performance.now()
        const image = { width: decoded.info.width, height: decoded.info.height, data: decoded.data }
        const grid = chooseGrid(image, candidates, words)
        const gridAt = performance.now()
        const found = scanGrid(image, grid, candidates, index, { words })
        const end = performance.now()
        sample.stages = { decodeMs: decodedAt - start, ocrMs: ocrAt - decodedAt, gridMs: gridAt - ocrAt, matchMs: end - gridAt, totalMs: end - start }
        sample.ok = true
        sample.found = found
        sample.processMemoryAfter = process.memoryUsage()
        if (input.entry.expected) sample.agreement = labelAgreement(found, input.entry.expected)
      } catch (error) {
        sample.error = error instanceof Error ? error.message : String(error)
        sample.failureElapsedMs = performance.now() - attemptAt
      }
      samples.push(sample)
    }
  }
} finally {
  let closeError: string | null = null
  try { await closeOcr() } catch (error) { closeError = error instanceof Error ? error.message : String(error) }
  const summary = []
  for (const stratum of new Set(samples.map((s) => s.stratum))) for (const phase of ['cold-worker', 'warm-worker'] as const) {
    const selected = samples.filter((s) => s.stratum === stratum && s.phase === phase)
    summary.push({ stratum, phase, attempted: selected.length, failures: selected.filter((s) => !s.ok).length, stages: Object.fromEntries(['decodeMs', 'ocrMs', 'gridMs', 'matchMs', 'totalMs'].map((key) => [key, quantiles(selected.flatMap((s) => s.stages ? [s.stages[key as keyof Stages]] : []))])) })
  }
  const result = {
    schemaVersion: 1,
    recordedAtUtc: new Date().toISOString(),
    runner: 'node-cli-scanner-measurement',
    node: process.version, platform: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model,
    corpusDescription: corpus.description,
    manifestSha256: hash(manifestBytes),
    fingerprintHeaderSha256: hash(fs.readFileSync(headerFile)),
    fingerprintPixelsSha256: hash(fs.readFileSync(pixelsFile)),
    ocrModelSha256: mode === 'on' ? hash(fs.readFileSync(ocrModelFile)) : null,
    dependencyLockSha256: fs.existsSync('package-lock.json') ? hash(fs.readFileSync('package-lock.json')) : null,
    ocrMode: mode,
    corpus: inputs.map(({ entry, wordsSha256 }) => ({ id: entry.id, stratum: entry.stratum, sha256: entry.sha256, wordsSha256, labelsSupplied: Boolean(entry.expected) })),
    descriptorInitialization: inits,
    summary, samples, closeError,
    limitations: [
      'Measurement only; no assertions or pass/fail accuracy gate.',
      'Cold-worker means a fresh OCR worker and descriptor index, not a cold OS cache or fresh Node process.',
      'After an OCR initialization failure, a nominal warm-worker attempt may retry initialization.',
      'Node OCR helper uses sharp preprocessing and differs from renderer bicubic preprocessing.',
      'No capture, browser worker transfer, UI review, storage commit or user input latency is included.',
      'OCR stage includes local model startup for cold-worker and repeats image decode/preprocessing inside the existing helper.',
      'Descriptor initialization is reported separately, outside totalMs.',
      'Success-only percentiles are accompanied by attempted/failure counts; failures are retained.',
      'Memory is one Node process snapshot after each scan, not peak memory or all OCR-worker process memory.',
      'Supplied labels measure exact item identity/cell geometry only; no quantities/FIR are inferred.',
      'No real corpus or baseline result is provided by this repository change.',
    ],
  }
  fs.writeFileSync(output, JSON.stringify(result, null, 2), { flag: 'wx' })
  console.log(output)
}

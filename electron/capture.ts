/**
 * Stash scanner support in the main process: screen capture for the scan hotkey,
 * read-only access to Escape from Tarkov's own screenshot folder, and reading the
 * bundled scanner data (Chromium cannot fetch() file:// URLs from the page).
 * Nothing here touches the game: a screen capture is the same as Win+Shift+S.
 */
import { app, desktopCapturer, screen } from 'electron'
import type { Display } from 'electron'
import fs from 'node:fs'
import { isScreenshotName } from './security'
import { installedPackDir, packsEnabled } from './packs'
import path from 'node:path'
import type { PackName } from '../src/shared/desktop-api'

/** Captures the display under the mouse at full resolution, as PNG bytes. */
export function captureScreenUnderCursor(): Promise<Uint8Array> {
  return captureDisplay(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
}

/** Captures one display at full resolution, as PNG bytes. */
export async function captureDisplay(display: Display): Promise<Uint8Array> {
  const size = {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  }
  if (size.width * size.height > 40_000_000) throw new Error('Monitor dimensions exceed the capture memory budget')
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
  const source = sources.find((s) => s.display_id === String(display.id))
  if (!source || source.thumbnail.isEmpty()) throw new Error('No picture is available for the selected screen')
  const bytes = source.thumbnail.toPNG()
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('Screenshot exceeds the capture byte budget')
  return new Uint8Array(bytes)
}

/** Where the game saves its own screenshots (Print Screen in game). */
export function gameScreenshotsDir(): string {
  // TC_SCREENSHOTS_DIR is for testing (a throwaway folder instead of the player's real screenshots).
  return process.env.TC_SCREENSHOTS_DIR || path.join(app.getPath('documents'), 'Escape from Tarkov', 'Screenshots')
}

export interface GameScreenshot {
  name: string
  modified: number
}

export function listGameScreenshots(limit = 12): GameScreenshot[] {
  const dir = gameScreenshotsDir()
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => /\.(png|jpe?g|bmp)$/i.test(n))
      .map((name) => ({ name, modified: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, limit)
  } catch {
    return []
  }
}

export function readGameScreenshot(name: string): Uint8Array {
  // Only plain file names inside the screenshots folder.
  if (!isScreenshotName(name)) throw new Error('Invalid file name')
  return new Uint8Array(fs.readFileSync(path.join(gameScreenshotsDir(), name)))
}

const RESOURCE_DIRS = ['scan', 'ocr', 'tiles']
/** Folders that come from a downloaded content pack in installed builds (see packs.ts). */
const PACKED: Record<string, PackName> = { tiles: 'lighthouse', scan: 'scan' }

function resourcePath(rel: string, devServer: boolean): string {
  const clean = path.normalize(rel).replace(/^([/\\])+/, '')
  const top = clean.split(/[/\\]/)[0]
  if (!RESOURCE_DIRS.includes(top) || clean.includes('..')) throw new Error('Not allowed')
  const pack = PACKED[top]
  if (pack && !devServer && packsEnabled()) {
    const dir = installedPackDir(pack)
    if (!dir) throw new Error('Not downloaded yet')
    return path.join(dir, clean)
  }
  const base = devServer ? path.join(__dirname, '..', 'public') : path.join(__dirname, '..', 'dist')
  return path.join(base, clean)
}

const MIME: Record<string, string> = { '.png': 'image/png', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.json': 'application/json', '.gz': 'application/gzip', '.bin': 'application/octet-stream', '.wasm': 'application/wasm' }

/** tcres://app/<dir>/<file> -> the bundled file, read-only, scanner and OCR folders only. */
export function resourceResponse(url: string, devServer: boolean): Response {
  try {
    const rel = decodeURIComponent(new URL(url).pathname)
    const file = resourcePath(rel, devServer)
    const body = fs.readFileSync(file)
    return new Response(body, { headers: { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' } })
  } catch {
    return new Response('Not found', { status: 404, headers: { 'access-control-allow-origin': '*' } })
  }
}

/** Reads a file shipped with the app (only the scanner data folder). */
export function readAppResource(rel: string, devServer: boolean): Uint8Array {
  const clean = path.normalize(rel).replace(/^([/\\])+/, '')
  if ((!clean.startsWith(`scan${path.sep}`) && !clean.startsWith('scan/')) || clean.includes('..')) throw new Error('Not allowed')
  return new Uint8Array(fs.readFileSync(resourcePath(clean, devServer)))
}

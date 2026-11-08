import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { generatedPath, root } from './scripts/lib/content-assets.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; productName: string; repository?: { url?: string } }
const repoUrl = (pkg.repository?.url ?? '').replace(/^git+/, '').replace(/.git$/, '')

/**
 * Content-Security-Policy for built pages (the dev server injects inline scripts for hot
 * reload, so it only applies to builds). The page may only run its own code and talk to the
 * services it uses: tarkov.dev (game data, pictures, map tiles) and the EFT Wiki (guides).
 * file: and tcres: are the desktop app's own files; blob: and wasm are the text reader (OCR).
 */
const CSP = [
  "default-src 'self' file:",
  "script-src 'self' file: tcres: blob: 'wasm-unsafe-eval'",
  "worker-src 'self' file: tcres: blob:",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: tcres: data: blob: https://assets.tarkov.dev https://static.wikia.nocookie.net",
  "font-src 'self' file: data:",
  "connect-src 'self' file: tcres: blob: data: https://json.tarkov.dev https://assets.tarkov.dev https://escapefromtarkov.fandom.com",
  "media-src 'self' file: data:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function separateLighthousePack(tauri: boolean): Plugin {
  return {
    name: 'tc-separate-lighthouse-pack',
    // Vite copies public assets before writing its bundle. The entire map, including
    // the drawing, belongs in the separately licensed content pack.
    writeBundle(output) {
      if (!tauri || !output.dir) return
      if (resolve(output.dir) !== generatedPath('dist-tauri')) throw new Error('Unexpected Tauri frontend output directory')
      const packDirectory = generatedPath('dist-tauri/tiles/lighthouse-re3mr')
      if (!existsSync(packDirectory)) return
      if (realpathSync(packDirectory) !== join(realpathSync(root), 'dist-tauri', 'tiles', 'lighthouse-re3mr'))
        throw new Error('Tauri Lighthouse output directory is redirected')
      rmSync(packDirectory, { recursive: true })
    },
  }
}

function contentSecurityPolicy(): Plugin {
  return {
    name: 'tc-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  }
}

export default defineConfig(({ mode }) => {
  const tauri = mode === 'tauri'
  return {
    base: tauri ? './' : '/',
    ...(tauri ? { build: { outDir: 'dist-tauri' } } : {}),
    // Classic (non-module) workers also load from file:// in the packaged desktop app.
    worker: { format: 'iife' as const },
    define: { 'import.meta.env.VITE_APP_NAME': JSON.stringify(pkg.productName), 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version), 'import.meta.env.VITE_REPO_URL': JSON.stringify(repoUrl) },
    plugins: [
      react(),
      tailwindcss(),
      separateLighthousePack(tauri),
      ...(!tauri ? [contentSecurityPolicy()] : []),
    ],
  }
})

import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'
import electron from 'vite-plugin-electron/simple'
import { existsSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string; productName: string; repository?: { url?: string } }
const repoUrl = (pkg.repository?.url ?? '').replace(/^git+/, '').replace(/.git$/, '')
// Content pack hashes (scripts/build-packs.mjs); null when packs were not built (development).
const packsManifest = existsSync('electron/packs.generated.json') ? readFileSync('electron/packs.generated.json', 'utf8') : 'null'

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

function contentSecurityPolicy(): Plugin {
  return {
    name: 'tc-csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  }
}

// `vite --mode desktop` / `vite build --mode desktop` adds the Electron main +
// preload builds and makes asset URLs relative so dist/index.html works from
// file://. Plain `vite` keeps producing the web app.
export default defineConfig(({ mode }) => {
  const desktop = mode === 'desktop'
  const tauri = mode === 'tauri'
  const cjs = { rollupOptions: { output: { format: 'cjs' as const, entryFileNames: '[name].cjs' } } }
  return {
    base: desktop || tauri ? './' : '/',
    ...(tauri ? { build: { outDir: 'dist-tauri' } } : {}),
    // Classic (non-module) workers also load from file:// in the packaged desktop app.
    worker: { format: 'iife' as const },
    define: { 'import.meta.env.VITE_APP_NAME': JSON.stringify(pkg.productName), 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version), 'import.meta.env.VITE_REPO_URL': JSON.stringify(repoUrl) },
    plugins: [
      react(),
      tailwindcss(),
      ...(!tauri ? [contentSecurityPolicy()] : []),
      ...(desktop
        ? [
            electron({
              main: {
                entry: 'electron/main.ts',
                vite: {
                  define: { __TC_PACKS__: packsManifest },
                  build: {
                    outDir: 'dist-electron',
                    lib: { entry: 'electron/main.ts', formats: ['cjs'], fileName: () => 'main.cjs' },
                    rollupOptions: { output: { format: 'cjs' } },
                  },
                },
              },
              preload: {
                input: 'electron/preload.ts',
                vite: { build: { outDir: 'dist-electron', ...cjs } },
              },
            }),
          ]
        : []),
    ],
  }
})

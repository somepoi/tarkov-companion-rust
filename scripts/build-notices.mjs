// Writes THIRD_PARTY_NOTICES.txt: the licence of every open-source package that ships inside the
// app (renderer libraries bundled by Vite, the Electron runtime, the updater and their runtime
// dependencies), plus the data and imagery sources. Shipped next to the app (extraResources)
// and published in the repository. Usage: npm run notices
import fs from 'node:fs'
import path from 'node:path'

// Packages whose code ends up in the shipped app (build tools, types and test tools do not).
const SHIPPED = [
  'react', 'react-dom', 'scheduler', 'react-router', 'react-router-dom', 'cookie', 'set-cookie-parser',
  '@tanstack/react-query', '@tanstack/query-core', '@tanstack/react-query-persist-client', '@tanstack/query-persist-client-core',
  '@tanstack/react-virtual', '@tanstack/virtual-core', 'zustand', 'use-sync-external-store',
  '@tauri-apps/api',
  'leaflet', 'react-leaflet', '@react-leaflet/core', '@geoman-io/leaflet-geoman-free', 'lucide-react', 'idb-keyval',
  'tesseract.js', 'tesseract.js-core', 'tailwindcss',
  'electron', 'electron-updater', 'builder-util-runtime', 'debug', 'ms', 'sax', 'fs-extra', 'graceful-fs', 'jsonfile', 'universalify',
  'js-yaml', 'argparse', 'semver', 'lazy-val', 'lodash.escaperegexp', 'lodash.isequal', 'tiny-typed-emitter',
]

const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE', 'LICENSE-MIT', 'COPYING']

function findPackage(name) {
  const dir = path.join('node_modules', ...name.split('/'))
  return fs.existsSync(path.join(dir, 'package.json')) ? dir : null
}

const parts = [
  'Tarkov Companion — third-party notices',
  '',
  'Tarkov Companion includes the open-source software listed below. Each is used under its own',
  'licence, reproduced here. Game content, names and item pictures belong to Battlestate Games;',
  'this app is not affiliated with or endorsed by Battlestate Games.',
  '',
  'Data and imagery (downloaded or bundled):',
  '- tarkov.dev (the-hideout): game data API and map transforms, MIT. https://tarkov.dev',
  '- tarkov-dev-svg-maps / tarkov.dev map imagery: CC BY-NC-SA 4.0, by the authors credited per map.',
  '- RE3MR Lighthouse render (reemr.se): CC BY-NC-SA 4.0, by re3mr. Sliced into map tiles for this app;',
  '  the tiles are shared under the same licence, may not be used commercially, and are not part of',
  '  the GPL program (the desktop app downloads them separately as a content pack).',
  '- Stash scanner data: small fingerprints of Battlestate Games item pictures (via tarkov.dev); not part',
  '  of the GPL program, bundled or supplied separately as a content pack.',
  '- Escape from Tarkov Wiki (escapefromtarkov.fandom.com): CC BY-SA 3.0. Quest guides and story chapters.',
  '- Tesseract English model (tessdata, via @tesseract.js-data/eng): Apache-2.0.',
  '',
]
const missing = []
for (const name of SHIPPED) {
  const dir = findPackage(name)
  if (!dir) {
    missing.push(name)
    continue
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const licenseFile = LICENSE_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f))
  parts.push('='.repeat(78), `${pkg.name} ${pkg.version} — ${typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see below')}`, pkg.homepage ?? '', '-'.repeat(78))
  parts.push(licenseFile ? fs.readFileSync(licenseFile, 'utf8').trim() : `Licence: ${pkg.license ?? 'unknown'} (no licence file in the package)`, '')
}
// Electron ships Chromium; its notices are bundled by Electron itself (LICENSES.chromium.html).
parts.push('='.repeat(78), 'Chromium and its components: see LICENSES.chromium.html next to the program file.', '')
fs.writeFileSync('THIRD_PARTY_NOTICES.txt', parts.join('\n'))
console.log(`THIRD_PARTY_NOTICES.txt: ${SHIPPED.length - missing.length} packages${missing.length ? `; not installed here (skipped): ${missing.join(', ')}` : ''}`)

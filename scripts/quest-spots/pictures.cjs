// Downloads EFT Wiki pictures by file name (original PNG/JPEG, not WebP) so quest spots can be read off them.
// Usage: node scripts/quest-spots/pictures.cjs <outDir> "<File name.png>" ...
const fs = require('fs')
const path = require('path')
const API = 'https://escapefromtarkov.fandom.com/api.php'
const [out, ...files] = process.argv.slice(2)
fs.mkdirSync(out, { recursive: true })
const get = async (params) => (await fetch(`${API}?${new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params })}`)).json()
;(async () => {
  for (const f of files) {
    const info = await get({ action: 'query', titles: `File:${f}`, prop: 'imageinfo', iiprop: 'url|size' })
    const ii = info.query?.pages?.[0]?.imageinfo?.[0]
    if (!ii) {
      console.log(`missing: ${f}`)
      continue
    }
    const r = await fetch(ii.url + (ii.url.includes('?') ? '&' : '?') + 'format=original', { headers: { Referer: 'https://escapefromtarkov.fandom.com/' } })
    const name = f.replace(/[^\w.]+/g, '_')
    fs.writeFileSync(path.join(out, name), Buffer.from(await r.arrayBuffer()))
    console.log(`${name} ${ii.width}x${ii.height} ${r.status}`)
  }
})()

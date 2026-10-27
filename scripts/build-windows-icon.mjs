// Package the existing project artwork as a Windows ICO; attribution is unchanged.
import fs from 'node:fs'
import sharp from 'sharp'

const png = await sharp('build/icon.png').resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer()
const header = Buffer.alloc(22)
header.writeUInt16LE(1, 2) // icon type
header.writeUInt16LE(1, 4) // one PNG-compressed entry, 0 dimensions mean 256x256
header.writeUInt16LE(1, 10)
header.writeUInt16LE(32, 12)
header.writeUInt32LE(png.length, 14)
header.writeUInt32LE(header.length, 18)
fs.mkdirSync('src-tauri/icons', { recursive: true })
fs.writeFileSync('src-tauri/icons/icon.ico', Buffer.concat([header, png]))

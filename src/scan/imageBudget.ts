import { checkedCrop, type ImageSize } from './registration'

const MAX_BYTES = 64 * 1024 * 1024
const HEADER_BYTES = 1024 * 1024

/** Read bounded raster headers before asking the browser to allocate pixels. */
export async function screenshotSize(image: Blob): Promise<ImageSize> {
  if (!image.size || image.size > MAX_BYTES)
    throw new Error('Screenshots must contain between 1 byte and 64 MiB.')
  const bytes = new Uint8Array(await image.slice(0, HEADER_BYTES).arrayBuffer())
  const view = new DataView(bytes.buffer)
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  let width = 0, height = 0
  if (bytes.length >= 24 && bytes[0] === 137 && text(1, 7) === 'PNG\r\n\x1a\n' && text(12, 4) === 'IHDR') {
    width = view.getUint32(16); height = view.getUint32(20)
  } else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) {
    width = view.getUint16(6, true); height = view.getUint16(8, true)
  } else if (bytes.length >= 26 && text(0, 2) === 'BM') {
    const header = view.getUint32(14, true)
    if (header === 12) {
      width = view.getUint16(18, true); height = view.getUint16(20, true)
    } else if (header >= 40) {
      width = view.getInt32(18, true); height = Math.abs(view.getInt32(22, true))
    }
  } else if (bytes.length >= 25 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    const chunk = text(12, 4)
    if (chunk === 'VP8X' && bytes.length >= 30) {
      width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16)
      height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16)
    } else if (chunk === 'VP8 ' && bytes.length >= 30 && text(23, 3) === '\x9d\x01\x2a') {
      width = view.getUint16(26, true) & 0x3fff
      height = view.getUint16(28, true) & 0x3fff
    } else if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true)
      width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff)
    }
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) break
      while (offset < bytes.length && bytes[offset] === 0xff) offset++
      if (offset >= bytes.length) break
      const marker = bytes[offset++]
      if (marker === 0xda || marker === 0xd9) break
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) break
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 8) {
        height = view.getUint16(offset + 3); width = view.getUint16(offset + 5)
        break
      }
      offset += length
    }
  }
  if (!width || !height)
    throw new Error('Cannot read bounded screenshot dimensions. Use PNG, JPEG, WebP, BMP or GIF with image metadata within the first 1 MiB.')
  checkedCrop(null, { width, height })
  return { width, height }
}

/** Header checks limit admission; the decoder still validates the actual file. */
export async function decodeScreenshot(image: Blob, signal?: AbortSignal): Promise<ImageBitmap> {
  signal?.throwIfAborted()
  await screenshotSize(image)
  signal?.throwIfAborted()
  const bitmap = await createImageBitmap(image)
  try {
    signal?.throwIfAborted()
    checkedCrop(null, bitmap)
    return bitmap
  } catch (error) {
    bitmap.close()
    throw error
  }
}

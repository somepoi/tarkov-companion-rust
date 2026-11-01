import PreparationWorker from './ocrPreparation.worker?worker'
import type { ImageCrop } from './registration'
import type { PreparedText, TextPreparationOptions, TextPreparationRequest, TextPreparationResponse } from './ocrPreparation'

/** OCR queue admits one preprocessing worker at a time; never retain pixel buffers. */
export function prepareText(image: Blob, crop: ImageCrop | null, options: TextPreparationOptions, signal?: AbortSignal): Promise<PreparedText> {
  signal?.throwIfAborted()
  if (!image.size || image.size > 64 * 1024 * 1024)
    return Promise.reject(new Error('Screenshots must contain between 1 byte and 64 MiB.'))
  return new Promise<PreparedText>((resolve, reject) => {
    const worker = new PreparationWorker()
    const dispose = () => {
      signal?.removeEventListener('abort', abort)
      worker.onmessage = null
      worker.onerror = null
      worker.onmessageerror = null
      worker.terminate()
    }
    const fail = (error: Error) => { dispose(); reject(error) }
    const abort = () => fail(new DOMException('Text preparation cancelled', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<TextPreparationResponse>) => {
      dispose()
      if ('error' in event.data) reject(new Error(event.data.error))
      else resolve(event.data.result)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      fail(new Error(event.message || 'Text image preparation stopped. Try a smaller selection.'))
    }
    worker.onmessageerror = () => fail(new Error('Text image preparation returned unreadable data.'))
    try {
      // Only send serializable options; isCurrent callbacks and signals stay on the page.
      const request: TextPreparationRequest = { image, crop, options: { threshold: options.threshold, scale: options.scale } }
      worker.postMessage(request)
    } catch (cause) {
      fail(cause instanceof Error ? cause : new Error(String(cause)))
    }
  })
}

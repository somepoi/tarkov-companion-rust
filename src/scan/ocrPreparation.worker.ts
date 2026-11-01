/// <reference lib="webworker" />
import { prepareTextPixels, type TextPreparationRequest, type TextPreparationResponse } from './ocrPreparation'

self.onmessage = async (event: MessageEvent<TextPreparationRequest>) => {
  const { image, crop, options } = event.data
  try {
    const result = await prepareTextPixels(image, crop, options)
    self.postMessage({ result } satisfies TextPreparationResponse)
  } catch (cause) {
    self.postMessage({ error: cause instanceof Error ? cause.message : String(cause) } satisfies TextPreparationResponse)
  }
}

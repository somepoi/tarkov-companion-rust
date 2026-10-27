import { listen } from '@tauri-apps/api/event'

/** Unsubscribe is synchronous even when registration finishes after React cleanup. */
export function subscribe<T>(
  channel: string,
  cb: (payload: T) => void,
  onReady?: () => void,
): () => void {
  let disposed = false
  let stop: (() => void) | undefined
  void listen<T>(channel.replaceAll(':', '-'), (event) => {
    if (!disposed) cb(event.payload)
  })
    .then((unlisten) => {
      if (disposed) unlisten()
      else {
        stop = unlisten
        onReady?.()
      }
    })
    .catch((error: unknown) =>
      console.error(`Desktop subscription failed: ${channel}`, error),
    )
  return () => {
    disposed = true
    stop?.()
  }
}

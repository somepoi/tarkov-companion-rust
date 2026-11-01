/** Cancel waiting without cancelling shared initialization needed by other callers. */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new DOMException('Recognition cancelled', 'AbortError'))
    }
    const clear = () => signal.removeEventListener('abort', abort)
    // Always observe work, including when cancellation has already happened.
    work.then((value) => { clear(); resolve(value) }, (error: unknown) => { clear(); reject(error) })
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

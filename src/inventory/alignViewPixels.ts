import type { ScanDraft } from './client'
import type { Grid } from '../scan/core'
import AlignmentWorker from './viewAlignment.worker?worker'

export interface AlignmentAnchor { column: number; row: number; width: number; height: number; grid: Grid }
export interface AlignmentSource { image: Blob; columns: number; rows: number; anchors: AlignmentAnchor[] }
export interface AlignmentRequest {
  current: AlignmentSource
  reference: AlignmentSource & { column: number; row: number }
  container: { columns: number; rows: number }
}
export interface AlignmentProposal { column: number; row: number; matchedPatches: number; overlapCells: number }
export type AlignmentResponse = { proposal: AlignmentProposal | null; message: string }

/** Match pixels from reviewed observed footprints, never guessed item identities. */
export function alignmentSource(image: Blob, hash: string, draft: ScanDraft, columns: number, rows: number): AlignmentSource {
  const observations = new Map(draft.observations.map((entry) => [entry.id, entry]))
  const anchors: AlignmentAnchor[] = []
  for (const stack of draft.stacks) {
    const observation = observations.get(stack.provenance.observationId ?? '')
    const grid = observation?.sourceGrid
    if (!stack.itemId || !stack.provenance.identityConfirmed || stack.provenance.screenshotHash !== hash
      || observation?.screenshotHash !== hash || !grid || grid.cols !== columns || grid.rows !== rows) continue
    if (anchors.length === 128) throw new Error('This view has more than 128 reviewed pixel anchors. Enter the position manually.')
    anchors.push({ ...stack.location, grid: { ...grid } })
  }
  return { image, columns, rows, anchors }
}

export function suggestAlignment(request: AlignmentRequest, signal: AbortSignal): Promise<AlignmentResponse> {
  if (signal.aborted) return Promise.reject(new Error('Position hint cancelled'))
  return new Promise((resolve, reject) => {
    const worker = new AlignmentWorker()
    let finished = false
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); worker.terminate() }
    const fail = (message: string) => { if (finished) return; finished = true; cleanup(); reject(new Error(message)) }
    const cancel = () => fail('Position hint cancelled')
    const timer = setTimeout(() => fail('Position hint timed out. Enter the view position manually.'), 45_000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.onerror = () => fail('Position hint stopped unexpectedly. Enter the view position manually.')
    worker.onmessageerror = () => fail('Could not read the position hint. Enter the view position manually.')
    worker.onmessage = (event: MessageEvent<AlignmentResponse & { error?: string }>) => {
      if (finished) return
      if (event.data.error) { fail(event.data.error); return }
      finished = true; cleanup(); resolve(event.data)
    }
    try { worker.postMessage(request) } catch (error) { fail(String(error)) }
  })
}

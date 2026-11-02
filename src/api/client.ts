/**
 * Low-level client for the tarkov.dev static JSON API.
 * Catalog:   https://json.tarkov.dev/endpoints
 * Documents: https://json.tarkov.dev/{gameMode}/{endpoint}  (+ "_{lang}" for translations)
 */

import { invoke, isTauri } from '@tauri-apps/api/core'

export const JSON_API_BASE = 'https://json.tarkov.dev'

export type GameMode = 'regular' | 'pve'

export const GAME_MODES: ReadonlyArray<{ id: GameMode; label: string; description: string }> = [
  { id: 'regular', label: 'PvP', description: 'Regular (PvP) game mode' },
  { id: 'pve', label: 'PvE', description: 'PvE game mode' },
]

export type EndpointName = 'tasks' | 'items' | 'traders' | 'maps' | 'hideout' | 'crafts' | 'barters'

export type Language = 'en'

export class TarkovApiError extends Error {
  readonly status: number
  readonly url: string
  constructor(message: string, status: number, url: string) {
    super(message)
    this.name = 'TarkovApiError'
    this.status = status
    this.url = url
  }
}

/** Builds "/{gameMode}/{endpoint}" or "/{gameMode}/{endpoint}_{lang}". */
export function modePath(gameMode: GameMode, endpoint: EndpointName, lang?: Language): string {
  return `/${gameMode}/${endpoint}${lang ? `_${lang}` : ''}`
}

/** A stalled connection gives up after this long (the items document is large on slow lines). */
const REQUEST_TIMEOUT_MS = 90_000

export async function fetchJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const url = `${JSON_API_BASE}${path}`
  signal?.throwIfAborted()
  if (isTauri()) {
    try {
      const document = await invoke<T>('fetch_catalog_document', { path })
      signal?.throwIfAborted()
      return document
    } catch (cause) {
      signal?.throwIfAborted()
      throw new TarkovApiError(typeof cause === 'string' ? cause : String(cause), 0, url)
    }
  }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout
  let res: Response
  try {
    // The API sends an 8-day Cache-Control; without no-cache the browser would keep
    // serving stale prices and trader reset times. no-cache revalidates via ETag,
    // so unchanged documents cost a 304, not a re-download.
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: both, cache: 'no-cache' })
  } catch (err) {
    if (timeout.aborted && !signal?.aborted) {
      throw new TarkovApiError('json.tarkov.dev is not answering (timed out). It will be tried again in a minute.', 0, url)
    }
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    throw new TarkovApiError(
      'Could not reach json.tarkov.dev. Check your internet connection and try again.',
      0,
      url,
    )
  }
  if (!res.ok) {
    throw new TarkovApiError(
      `tarkov.dev API request failed with HTTP ${res.status} for ${path}.`,
      res.status,
      url,
    )
  }
  try {
    return (await res.json()) as T
  } catch {
    throw new TarkovApiError(`tarkov.dev API returned invalid JSON for ${path}.`, res.status, url)
  }
}

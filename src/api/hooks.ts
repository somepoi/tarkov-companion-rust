import { useQuery } from '@tanstack/react-query'
import { catalogKeys, fetchEndpointCatalog } from './catalog'
import type { GameMode } from './client'
import { fetchCrafts, fetchGameData, fetchHideout, fetchItems, fetchPriceHistory, fetchServerStatus } from './queries'
import { FIVE_MINUTES, ONE_MINUTE, contentMs, refreshMs } from './queryClient'
import type { GameData } from './types'
import { useProgressStore } from '../store/progress'
import { PLANNING_CATALOG_SCHEMA } from './planningItems'

/** Game content: check every few hours (Settings); while in error, every minute. */
export const contentOrRetry = (status: 'pending' | 'error' | 'success') =>
  status === 'error' ? ONE_MINUTE : contentMs()

export interface GameDataOptions {
  /** A screen that shows live values riding along in this data (the Goons' map) asks for this interval while open. */
  refetchMs?: number
  /** Restock countdowns: refresh just after a trader's restock time passes, to get the next one. */
  followRestocks?: boolean
}

/** Next refresh of the tasks/traders/maps data for one screen's needs. */
export function gameDataInterval(data: GameData | undefined, opts: GameDataOptions, now = Date.now()): number {
  let ms = contentMs()
  if (opts.refetchMs) ms = Math.min(ms, opts.refetchMs)
  if (opts.followRestocks) {
    for (const t of data?.traders ?? []) if (t.resetTime != null && t.resetTime > now) ms = Math.min(ms, t.resetTime - now + 2 * ONE_MINUTE)
  }
  return Math.max(ms, ONE_MINUTE)
}

export const gameDataKeys = {
  all: ['gameData'] as const,
  mode: (gameMode: GameMode) => ['gameData', gameMode] as const,
}
export const itemKeys = {
  all: ['items'] as const,
  mode: (gameMode: GameMode) => ['items', gameMode] as const,
}
export const priceKeys = {
  item: (gameMode: GameMode, itemId: string) => ['prices', gameMode, itemId] as const,
}

export function useEndpointCatalog() {
  return useQuery({
    queryKey: catalogKeys.all,
    queryFn: ({ signal }) => fetchEndpointCatalog(signal),
  })
}

/** Tasks, traders and maps for the game mode selected in the store. */
export function useGameData(opts: GameDataOptions = {}) {
  const gameMode = useProgressStore((s) => s.gameMode)
  return useQuery({
    queryKey: gameDataKeys.mode(gameMode),
    queryFn: ({ signal }) => fetchGameData(gameMode, signal),
    staleTime: (query) => query.state.data?.planningSchema === PLANNING_CATALOG_SCHEMA ? gameDataInterval(query.state.data, opts) : 0,
    refetchInterval: (query) => (query.state.status === 'error' ? ONE_MINUTE : gameDataInterval(query.state.data, opts)),
  })
}

/**
 * Item catalogue (large download); pass enabled=false to defer loading.
 * `refetchMs` lets a screen (the Flea tab) ask for fresher prices while mounted;
 * TanStack uses the smallest interval among active observers.
 */
export function useItems(enabled = true, refetchMs?: number) {
  const gameMode = useProgressStore((s) => s.gameMode)
  return useQuery({
    queryKey: itemKeys.mode(gameMode),
    queryFn: ({ signal }) => fetchItems(gameMode, signal),
    enabled,
    staleTime: (query) => query.state.data?.planningSchema === PLANNING_CATALOG_SCHEMA ? (refetchMs ? Math.min(refetchMs, refreshMs()) : refreshMs()) : 0,
    refetchInterval: (query) => (query.state.status === 'error' ? ONE_MINUTE : (refetchMs ?? refreshMs())),
  })
}

export function useHideout() {
  const gameMode = useProgressStore((s) => s.gameMode)
  return useQuery({
    queryKey: ['hideout', gameMode] as const,
    queryFn: ({ signal }) => fetchHideout(gameMode, signal),
    staleTime: contentMs(),
    refetchInterval: (query) => contentOrRetry(query.state.status),
  })
}

export function useCrafts() {
  const gameMode = useProgressStore((s) => s.gameMode)
  return useQuery({
    queryKey: ['crafts', gameMode] as const,
    queryFn: ({ signal }) => fetchCrafts(gameMode, signal),
    staleTime: contentMs(),
    refetchInterval: (query) => contentOrRetry(query.state.status),
  })
}

export function usePriceHistory(itemId: string | null) {
  const gameMode = useProgressStore((s) => s.gameMode)
  return useQuery({
    queryKey: priceKeys.item(gameMode, itemId ?? ''),
    queryFn: ({ signal }) => fetchPriceHistory(gameMode, itemId as string, signal),
    enabled: Boolean(itemId),
    staleTime: FIVE_MINUTES,
    gcTime: 15 * ONE_MINUTE,
  })
}

export function useServerStatus() {
  return useQuery({
    queryKey: ['status'] as const,
    queryFn: ({ signal }) => fetchServerStatus(signal),
    staleTime: FIVE_MINUTES,
  })
}

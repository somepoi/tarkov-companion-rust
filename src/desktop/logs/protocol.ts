import type {
  BackfillResult,
  GameEvent,
  WatcherState,
} from '../../shared/desktop-api'
export interface LogChunk {
  session: number
  folder: string
  file: string
  role: string
  text: string
  historical: boolean
  flush: boolean
  invalidUtf8: boolean
}
export type WorkerRequest =
  | { id: number; operation: 'drained' }
  | {
      id: number
      operation: 'chunk'
      stream: 'live' | 'history'
      chunk: LogChunk
    }
  | { id: number; operation: 'reset'; stream: 'live' | 'history' }
  | { id: number; operation: 'finish'; folders: number; files: number }
export interface WorkerResponse {
  id: number
  error?: string
  events?: GameEvent[]
  context?: Pick<WatcherState, 'sessionMode' | 'profileId' | 'accountId'>
  result?: BackfillResult
  warning?: string
}

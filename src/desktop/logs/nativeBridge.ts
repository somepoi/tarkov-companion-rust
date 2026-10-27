import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  BackfillProgress,
  BackfillResult,
  GameEvent,
  LogStatsData,
  WatcherState,
} from '../../shared/desktop-api'
import type { LogChunk, WorkerRequest, WorkerResponse } from './protocol'
import LogWorker from './native.worker?worker'
type WithoutId<T> = T extends { id: number } ? Omit<T, 'id'> : never

type State = WatcherState & { epoch: number }
const call = async <T>(channel: string, ...args: unknown[]): Promise<T> => {
  try {
    return await invoke<T>('desktop_call', { channel, args })
  } catch (e) {
    throw new Error(
      typeof e === 'object' && e !== null && 'message' in e
        ? String(e.message)
        : String(e),
    )
  }
}
export function nativeLogBridge() {
  let state: State = {
    epoch: 0,
    status: 'no-folder',
    logsPath: null,
    detectedPath: null,
    currentFolder: null,
    lastEventAt: null,
    sessionMode: 'unknown',
    profileId: null,
    accountId: null,
  }
  const eventListeners = new Set<(event: GameEvent) => void>()
  const stateListeners = new Set<(state: WatcherState) => void>()
  const progressListeners = new Set<(progress: BackfillProgress) => void>()
  const recent: GameEvent[] = []
  const worker = new LogWorker()
  let workerFailure: Error | null = null
  let next = 0
  const pending = new Map<
    number,
    { resolve: (r: WorkerResponse) => void; reject: (error: Error) => void }
  >()
  const job = (request: WithoutId<WorkerRequest>) =>
    new Promise<WorkerResponse>((resolve, reject) => {
      if (workerFailure) {
        reject(workerFailure)
        return
      }
      const id = ++next
      pending.set(id, { resolve, reject })
      worker.postMessage({ ...request, id })
    })
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    const request = pending.get(data.id)
    pending.delete(data.id)
    if (data.error) request?.reject(new Error(data.error))
    else request?.resolve(data)
  }
  const failWorker = (message: string) => {
    const error = new Error(
      message + '. Restart the app to reconnect log synchronization.',
    )
    workerFailure = error
    worker.terminate()
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    state = { ...state, status: 'error', message: error.message }
    publish()
  }
  worker.onerror = (event) =>
    failWorker(event.message || 'Native log parser stopped')
  worker.onmessageerror = () =>
    failWorker('The native log parser could not read its message')
  const publish = () => {
    for (const listener of stateListeners) listener(state)
  }
  let dirty = true
  let draining = false
  let fault = false
  let history: Promise<BackfillResult> | null = null
  let warning = ''
  const ready = listen<number>('native-logs-dirty', (event) => {
    if (event.payload < state.epoch) return
    if (event.payload !== state.epoch) fault = false
    dirty = true
    void drain()
  })
    .then(() => call<State>('watcher:connect'))
    .then((value) => {
      state = value
      publish()
      return value
    })
    .catch((error: unknown) => {
      fault = true
      state = { ...state, status: 'error', message: String(error) }
      publish()
      return state
    })
  async function drain() {
    if (draining || !eventListeners.size || fault) return
    draining = true
    try {
      await ready
      while (eventListeners.size) {
        dirty = false
        const value = await call<{ state: State; chunk: LogChunk | null }>(
          'watcher:next',
          state.epoch,
        ).catch(async () => {
          state = await call<State>('watcher:getState')
          await job({ operation: 'reset', stream: 'live' })
          return call<{ state: State; chunk: LogChunk | null }>(
            'watcher:next',
            state.epoch,
          )
        })
        const context =
          state.currentFolder === value.state.currentFolder &&
          state.epoch === value.state.epoch
            ? {
                sessionMode: state.sessionMode,
                profileId: state.profileId,
                accountId: state.accountId,
                lastEventAt: state.lastEventAt,
              }
            : {}
        if (
          state.epoch !== value.state.epoch ||
          state.currentFolder !== value.state.currentFolder
        )
          warning = ''
        state = { ...value.state, ...context }
        const parsed = value.chunk
          ? await job({
              operation: 'chunk',
              stream: 'live',
              chunk: value.chunk,
            })
          : value.state.status === 'watching'
            ? await job({ operation: 'drained' })
            : { id: 0 }
        state = { ...state, ...parsed.context }
        if (parsed.warning) warning = parsed.warning
        for (const event of parsed.events ?? []) {
          if (
            event.mode === 'unknown' &&
            (event.kind === 'taskFinished' ||
              event.kind === 'taskStarted' ||
              event.kind === 'taskFailed')
          )
            warning =
              'Quest events with unknown game mode were excluded from automatic progress. Read past logs or reconcile these quests manually.'
          if (event.kind === 'profile' || event.kind === 'gameVersion') {
            await call('watcher:identity', event).catch((error: unknown) => {
              state.message = `Log identity was not saved: ${String(error)}`
            })
          }
          state.lastEventAt = Date.now()
          recent.unshift(event)
          if (recent.length > 50) recent.pop()
          for (const listener of eventListeners) listener(event)
        }
        if (!state.message && warning) state.message = warning
        publish()
        if (!value.chunk && !dirty) break
      }
    } catch (error) {
      fault = true
      state = {
        ...state,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
      publish()
    } finally {
      draining = false
      if (dirty && !fault && eventListeners.size) void drain()
    }
  }
  async function backfill(): Promise<BackfillResult> {
    if (history) return history
    history = (async () => {
      await ready
      await job({ operation: 'reset', stream: 'history' })
      const started = await call<{ id: number; folders: number }>(
        'watcher:historyBegin',
      )
      try {
        for (;;) {
          const batch = await call<{
            done: boolean
            chunk?: LogChunk
            files?: number
            folders?: number
            progress?: BackfillProgress
          }>('watcher:historyNext', started.id)
          if (batch.progress)
            for (const listener of progressListeners) listener(batch.progress)
          if (batch.done) {
            const parsed = await job({
              operation: 'finish',
              files: batch.files ?? 0,
              folders: batch.folders ?? 0,
            })
            if (!parsed.result)
              throw new Error('Historical read did not return a result')
            for (const listener of progressListeners)
              listener({
                done: started.folders,
                total: started.folders,
                folder: '',
              })
            return parsed.result
          }
          if (batch.chunk)
            await job({
              operation: 'chunk',
              stream: 'history',
              chunk: batch.chunk,
            })
        }
      } finally {
        await call('watcher:historyCancel', started.id).catch(() => undefined)
        await job({ operation: 'reset', stream: 'history' }).catch(
          () => undefined,
        )
      }
    })().finally(() => {
      history = null
    })
    return history
  }
  return {
    getState: async (): Promise<WatcherState> => {
      await ready
      return state
    },
    getRecentEvents: async () => [...recent],
    onEvent: (cb: (event: GameEvent) => void) => {
      eventListeners.add(cb)
      void drain()
      return () => {
        eventListeners.delete(cb)
      }
    },
    onState: (cb: (state: WatcherState) => void) => {
      stateListeners.add(cb)
      return () => {
        stateListeners.delete(cb)
      }
    },
    onBackfillProgress: (cb: (progress: BackfillProgress) => void) => {
      progressListeners.add(cb)
      return () => {
        progressListeners.delete(cb)
      }
    },
    readPastLogs: backfill,
    readLogStats: async (): Promise<LogStatsData> => {
      const result = await backfill()
      const keep = new Set([
        'mapLoading',
        'raidMatched',
        'raidStarted',
        'raidEnded',
        'matchingAborted',
        'fleaSold',
        'fleaExpired',
        'fleaRating',
        'taskFinished',
        'taskStarted',
        'taskFailed',
      ])
      const sessions = result.sessions ?? []
      return {
        events: result.events.filter((e) => keep.has(e.kind)),
        sessions,
        accountId: state.accountId,
        from: sessions.length
          ? Math.min(...sessions.map((s) => s.start))
          : null,
        to: sessions.length ? Math.max(...sessions.map((s) => s.end)) : null,
        resetAtByMode: result.resetAtByMode ?? {
          regular: null,
          pve: null,
          seasonal: null,
          unknown: null,
        },
      }
    },
  }
}

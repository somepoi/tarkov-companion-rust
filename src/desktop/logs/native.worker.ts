/// <reference lib="webworker" />
import { GameLogInterpreter, LogEntrySplitter } from '../../shared/logs/parser'
import { emptyBackfill, finishBackfill } from '../../shared/logs/backfill'
import type { WorkerRequest, WorkerResponse } from './protocol'
import type { BackfillResult, GameEvent } from '../../shared/desktop-api'
type PeriodFacts = Pick<
  BackfillResult,
  'currentProfileByMode' | 'resetAtByMode'
>
const ctx = self as unknown as DedicatedWorkerGlobalScope
const fresh = () => ({
  session: -1,
  interpreter: new GameLogInterpreter(),
  files: new Map<
    string,
    { splitter: LogEntrySplitter; lines: number; historicalThrough: number }
  >(),
  first: Infinity,
  last: -Infinity,
  period: [] as GameEvent[],
  drained: false,
  facts: null as PeriodFacts | null,
  warning: '',
})
let live = fresh()
let history = fresh()
let result = emptyBackfill()
type CachedSession = { events: GameEvent[]; span: { start: number; end: number } | null; weight: number }
const cache = new Map<string, CachedSession>()
let cacheWeight = 0
let cacheEvents = 0
let sessionKey: string | null = null
let sessionCacheable = false
const appendHistory = (events: GameEvent[]) => {
  if (result.events.length + events.length > 200_000)
    throw new Error('Historical event limit exceeded; choose a smaller archived log directory')
  for (const event of events) result.events.push(event)
}
const cacheSession = (key: string) => {
  const events = history.period
  if (events.length > 50_000) return
  let weight = 0
  for (const event of events) {
    weight += JSON.stringify(event).length
    if (weight > 4_000_000) return
  }
  const old = cache.get(key)
  if (old) { cacheWeight -= old.weight; cacheEvents -= old.events.length; cache.delete(key) }
  while (cache.size && (cache.size >= 128 || cacheWeight + weight > 4_000_000 || cacheEvents + events.length > 50_000)) {
    const oldest = cache.keys().next().value!
    const entry = cache.get(oldest)!
    cacheWeight -= entry.weight; cacheEvents -= entry.events.length; cache.delete(oldest)
  }
  cache.set(key, { events: [...events], weight, span: Number.isFinite(history.first) && history.last >= history.first ? { start: history.first, end: history.last } : null })
  cacheWeight += weight; cacheEvents += events.length
}
const saveSpan = () => {
  if (Number.isFinite(history.first) && history.last >= history.first)
    result.sessions?.push({ start: history.first, end: history.last })
}
const questEvent = (event: GameEvent) =>
  event.kind === 'taskFinished' ||
  event.kind === 'taskStarted' ||
  event.kind === 'taskFailed'
function currentQuest(event: GameEvent, facts: PeriodFacts | null) {
  if (!questEvent(event)) return true
  if (!facts) return false
  return (
    event.mode !== 'unknown' &&
    'profileId' in event &&
    Boolean(event.profileId) &&
    event.profileId === facts?.currentProfileByMode[event.mode] &&
    event.at >= (facts.resetAtByMode?.[event.mode] ?? -Infinity)
  )
}
ctx.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.operation === 'reset') {
      if (data.stream === 'live') live = fresh()
      else {
        history = fresh()
        result = emptyBackfill()
        sessionKey = null
        sessionCacheable = false
      }
      ctx.postMessage({ id: data.id } satisfies WorkerResponse)
      return
    }
    if (data.operation === 'historyBegin') {
      if (sessionKey !== null || !/^[a-f0-9]{64}$/.test(data.key) || !Number.isSafeInteger(data.session))
        throw new Error('Invalid historical session admission')
      const cached = data.cacheable ? cache.get(data.key) : undefined
      history = fresh()
      if (cached) {
        appendHistory(cached.events)
        if (cached.span) result.sessions?.push({ ...cached.span })
        cache.delete(data.key); cache.set(data.key, cached)
      } else {
        history.session = data.session
        sessionKey = data.key
        sessionCacheable = data.cacheable
      }
      ctx.postMessage({ id: data.id, useCache: Boolean(cached) } satisfies WorkerResponse)
      return
    }
    if (data.operation === 'historyEnd') {
      if (sessionKey !== data.key || sessionCacheable !== data.cacheable) throw new Error('Historical session acknowledgement changed')
      saveSpan()
      if (data.cacheable) cacheSession(data.key)
      sessionKey = null
      sessionCacheable = false
      history = fresh()
      ctx.postMessage({ id: data.id } satisfies WorkerResponse)
      return
    }
    if (data.operation === 'finish') {
      if (sessionKey !== null) throw new Error('Historical session was not completed')
      saveSpan()
      result.folders = data.folders
      result.files = data.files
      ctx.postMessage({
        id: data.id,
        result: finishBackfill(result),
      } satisfies WorkerResponse)
      history = fresh()
      result = emptyBackfill()
      return
    }
    if (data.operation === 'drained') {
      let events: GameEvent[] = []
      if (!live.drained) {
        const evaluated = finishBackfill({
          ...emptyBackfill(),
          events: live.period,
        })
        live.facts = {
          currentProfileByMode: evaluated.currentProfileByMode,
          resetAtByMode: evaluated.resetAtByMode,
        }
        const latestMetadata = new Map<string, GameEvent>()
        const key = (event: GameEvent) =>
          event.kind === 'profile' ? `profile:${event.mode}` : 'version'
        for (const event of live.period)
          if (event.kind === 'profile' || event.kind === 'gameVersion')
            latestMetadata.set(key(event), event)
        events = live.period.filter((event) => {
          if (!event.historical) return false
          if (event.kind === 'profile' || event.kind === 'gameVersion')
            return latestMetadata.get(key(event)) === event
          if (questEvent(event) && !currentQuest(event, live.facts)) {
            live.warning =
              'Historical quest events outside the confirmed current profile/reset period were excluded. Use Read past logs for a review.'
            return false
          }
          return true
        })
        live.period = []
        live.drained = true
      }
      ctx.postMessage({
        id: data.id,
        events,
        warning: live.warning,
      } satisfies WorkerResponse)
      return
    }
    const { chunk, stream } = data
    if (chunk.invalidUtf8)
      throw new Error(
        'Log contains invalid UTF-8; review this file before synchronizing progress',
      )
    let state = stream === 'live' ? live : history
    if (stream === 'history' && (sessionKey === null || state.session !== chunk.session))
      throw new Error('Historical chunk does not match the admitted session')
    if (state.session !== chunk.session) {
      if (stream === 'history') saveSpan()
      state = fresh()
      state.session = chunk.session
      if (stream === 'live') live = state
      else history = state
    }
    let slot = state.files.get(chunk.file)
    if (!slot) {
      slot = {
        splitter: new LogEntrySplitter(4 * 1024 * 1024),
        lines: 0,
        historicalThrough: 0,
      }
      state.files.set(chunk.file, slot)
    }
    for (let i = 0; i < chunk.text.length; i++)
      if (chunk.text.charCodeAt(i) === 10) slot.lines++
    if (chunk.historical)
      slot.historicalThrough = slot.lines + (chunk.text.endsWith('\n') ? 0 : 1)
    const entries = slot.splitter.push(chunk.text)
    if (chunk.flush) entries.push(...slot.splitter.flush())
    const events = entries.flatMap((entry) => {
      state.first = Math.min(state.first, entry.at)
      state.last = Math.max(state.last, entry.at)
      return state.interpreter.interpret(
        entry,
        chunk.file,
        stream === 'history' || entry.line <= slot.historicalThrough,
      )
    })
    if (stream === 'history') {
      appendHistory(events)
      history.period.push(...events)
    } else if (!state.drained) {
      if (state.period.length + events.length > 200_000)
        throw new Error(
          'Current log session exceeds the supported historical event limit',
        )
      state.period.push(...events)
    }
    const published =
      stream === 'live'
        ? events.filter((event) => {
            if (!event.historical) return true
            if (!state.drained) return false
            if (questEvent(event) && !currentQuest(event, state.facts)) {
              state.warning =
                'A historical quest without confirmed current-profile attribution was excluded. Use Read past logs for review.'
              return false
            }
            return event.kind !== 'profile' && event.kind !== 'gameVersion'
          })
        : []
    ctx.postMessage({
      id: data.id,
      events: published,
      warning: state.warning,
      context: {
        sessionMode: state.interpreter.currentMode,
        profileId: state.interpreter.profileId,
        accountId: state.interpreter.accountId,
      },
    } satisfies WorkerResponse)
  } catch (error) {
    ctx.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies WorkerResponse)
  }
}

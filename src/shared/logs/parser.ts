/**
 * Escape from Tarkov log parsing. Pure TypeScript, no Node APIs, so it can be
 * unit-tested and reused for both live tailing and backfills.
 *
 * Log format (observed in build/Logs/log_<date>_<version>/*.log, EFT 1.1.5):
 *
 *   2026-09-11 17:54:36.021|1.1.5.0.47242|Info|application|Session mode: Pve
 *   2026-09-12 12:36:07.148|1.1.5.0.47242|Info|push-notifications|Got notification | UserMatchOver
 *   {
 *     "type": "userMatchOver",
 *     ...
 *   }
 *
 * i.e. `date time|version|level|category|message`, optionally followed by a
 * pretty-printed JSON object that ends with a line containing only `}`. Older
 * builds omit the version field and may add a timezone offset after the time.
 *
 * Which lines mean what was learned from the open-source TarkovMonitor project
 * (github.com/the-hideout/TarkovMonitor, GPL-3.0); this file is an independent
 * TypeScript implementation written against real log samples.
 */

import type { GameEvent, SessionMode } from '../desktop-api'

// ---------------------------------------------------------------------------
// Splitting raw text into entries (header line + optional JSON block)
// ---------------------------------------------------------------------------

export interface LogEntry {
  /** Timestamp parsed from the header, ms since epoch (local time). */
  at: number
  /** Everything after the timestamp, e.g. "1.1.5.0.47242|Info|application|Session mode: Pve". */
  rest: string
  /** Raw JSON text that followed the header, if any. */
  json: string | null
  /** 1-based line number of the header within the file. */
  line: number
}

const HEADER_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})(?: [+-]\d{2}:\d{2})?\|(.*)$/

function headerTimestamp(m: RegExpMatchArray): number {
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime()
}

/**
 * Incremental splitter: feed it chunks of a log file (in order) and it yields
 * complete entries. Keeps a partial trailing line and an unfinished JSON
 * block between calls, which is what tailing an actively written file needs.
 */
export class LogEntrySplitter {
  private readonly maxBufferedChars: number
  private jsonChars = 0
  constructor(maxBufferedChars = Infinity) { this.maxBufferedChars = maxBufferedChars }
  private partial = ''
  private lineNo = 0
  private current: { at: number; rest: string; line: number; json: string[]; inJson: boolean } | null = null

  push(chunk: string): LogEntry[] {
    const out: LogEntry[] = []
    const text = this.partial + chunk
    const lines = text.split('\n')
    this.partial = lines.pop() ?? ''
    for (const raw of lines) out.push(...this.feedLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw))
    if (this.partial.length + this.jsonChars > this.maxBufferedChars) throw new Error('Log entry exceeds the supported parser size')
    return out
  }

  /** Call at end of file (backfills) to release the last entry. */
  flush(): LogEntry[] {
    const out: LogEntry[] = []
    if (this.partial) {
      const p = this.partial
      this.partial = ''
      out.push(...this.feedLine(p))
    }
    const last = this.finish()
    if (last) out.push(last)
    return out
  }

  private finish(): LogEntry | null {
    const c = this.current
    this.current = null
    this.jsonChars = 0
    if (!c) return null
    return { at: c.at, rest: c.rest, line: c.line, json: c.json.length ? c.json.join('\n') : null }
  }

  private feedLine(line: string): LogEntry[] {
    this.lineNo += 1
    const out: LogEntry[] = []
    const m = HEADER_RE.exec(line)
    if (m) {
      const prev = this.finish()
      if (prev) out.push(prev)
      this.current = { at: headerTimestamp(m), rest: m[8], line: this.lineNo, json: [], inJson: false }
      return out
    }
    const c = this.current
    if (!c) return out
    if (!c.inJson) {
      if (line.trim().startsWith('{')) {
        c.inJson = true
        c.json.push(line)
        this.jsonChars += line.length + 1
        if (line.trim() === '}' || isBalanced(c.json)) {
          c.inJson = false
          out.push(this.finish() as LogEntry)
        }
      }
      // Other continuation lines (stack traces etc.) are ignored.
      return out
    }
    c.json.push(line)
    this.jsonChars += line.length + 1
    if (/^\}\s*$/.test(line) && isBalanced(c.json)) {
      c.inJson = false
      out.push(this.finish() as LogEntry)
    }
    return out
  }
}

/** Cheap brace balance check so a JSON block ends at the right `}` line. */
function isBalanced(lines: string[]): boolean {
  let depth = 0
  let inStr = false
  for (const l of lines) {
    for (let i = 0; i < l.length; i++) {
      const ch = l[i]
      if (inStr) {
        if (ch === '\\') i++
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') depth--
    }
  }
  return depth <= 0
}

// ---------------------------------------------------------------------------
// Turning entries into game events
// ---------------------------------------------------------------------------

export function normalizeSessionMode(raw: string): SessionMode {
  const v = raw.trim().toLowerCase()
  if (v === 'pve') return 'pve'
  if (v === 'regular' || v === 'pvp') return 'regular'
  if (v === 'pvpseason' || v === 'seasonal' || v === 'szn') return 'seasonal'
  return 'unknown'
}

/** Chat message types that carry quest/flea information (EFT's MessageType enum). */
const MSG_FLEA = 4
const MSG_TASK_STARTED = 10
const MSG_TASK_FAILED = 11
const MSG_TASK_FINISHED = 12
const FLEA_SOLD_TEMPLATE = '5bdabfb886f7743e152e867e 0'
const FLEA_EXPIRED_TEMPLATE = '5bdabfe486f7743e1665df6e 0'
/** Money item templates in a flea sale's payment (the sale message carries what the buyer paid). */
const MONEY_TPL: Record<string, 'RUB' | 'USD' | 'EUR'> = {
  '5449016a4bdc2d6f028b456f': 'RUB',
  '5696686a4bdc2da3298b456a': 'USD',
  '569668774bdc2da2298b4568': 'EUR',
}

const PROFILE_RE = /(?:Select(?:ed)?Profile|PrepareSelectedProfileLocally|CompleteSelectedProfile) ProfileId:(\w+) AccountId:(\d+)/
const SESSION_MODE_RE = /Session mode: ([^\s|]+)/
const VERSION_RE = /Init: pstrGameVersion: Escape from Tarkov ([\w.]+)/
const SCENE_RE = /scene preset path:(maps\/[A-Za-z0-9_]+\.bundle)/
const NETGAME_RE = /TRACE-NetworkGameCreate profileStatus: '(.*)'/

function field(blob: string, name: string): string {
  const m = new RegExp(`${name}: ([^,']+)`).exec(blob)
  return m ? m[1].trim() : ''
}

interface ModeChange {
  at: number
  mode: SessionMode
}

interface ProfileChange {
  at: number
  profileId: string
}

/** The second word of a quest message's templateId, per message type. Anything else is ignored. */
const TASK_TEMPLATE_SUFFIX: Record<number, string> = {
  10: 'description',
  11: 'failMessageText',
  12: 'successMessageText',
}
const OBJECT_ID_RE = /^[0-9a-f]{24}$/

/**
 * Stateful interpreter for one game session (one log folder). Feed it entries
 * from the application log and the notifications log; it tracks the session
 * mode over time so notifications are attributed to the right mode even
 * though they live in a different file.
 */
export class GameLogInterpreter {
  private modeTimeline: ModeChange[] = []
  private profileTimeline: ProfileChange[] = []
  profileId: string | null = null
  /** Numeric BSG account id (the id tarkov.dev's player pages use). */
  accountId: string | null = null
  gameVersion: string | null = null
  private seq = 0

  get currentMode(): SessionMode {
    return this.modeTimeline.length ? this.modeTimeline[this.modeTimeline.length - 1].mode : 'unknown'
  }

  /** Session mode in effect at a given time (notifications arrive in another file). */
  modeAt(at: number): SessionMode {
    let mode: SessionMode = 'unknown'
    for (const c of this.modeTimeline) {
      if (c.at <= at) mode = c.mode
      else break
    }
    // A notification logged a moment before the mode line of the same session
    // still belongs to that session's first mode.
    if (mode === 'unknown' && this.modeTimeline.length) return this.modeTimeline[0].mode
    return mode
  }

  /** Profile selected at a given time (notifications arrive in another file). */
  profileAt(at: number): string | null {
    let id: string | null = null
    for (const c of this.profileTimeline) {
      if (c.at <= at) id = c.profileId
      else break
    }
    if (id === null && this.profileTimeline.length) return this.profileTimeline[0].profileId
    return id
  }

  interpret(entry: LogEntry, file: string, historical: boolean): GameEvent[] {
    const base = () => ({
      id: `${file}:${entry.line}:${this.seq++}`,
      at: entry.at,
      mode: this.modeAt(entry.at),
      historical,
      source: { file, line: entry.line },
    })
    const rest = entry.rest
    const out: GameEvent[] = []

    const mode = SESSION_MODE_RE.exec(rest)
    if (mode) {
      const normalized = normalizeSessionMode(mode[1])
      this.modeTimeline.push({ at: entry.at, mode: normalized })
      this.modeTimeline.sort((a, b) => a.at - b.at)
      out.push({ ...base(), kind: 'sessionMode', raw: mode[1], mode: normalized })
      return out
    }

    const prof = PROFILE_RE.exec(rest)
    if (prof) {
      if (prof[1] !== this.profileId) {
        this.profileTimeline.push({ at: entry.at, profileId: prof[1] })
        this.profileTimeline.sort((a, b) => a.at - b.at)
        this.profileId = prof[1]
        this.accountId = prof[2]
        out.push({ ...base(), kind: 'profile', profileId: prof[1], accountId: prof[2] })
      }
      return out
    }

    const ver = VERSION_RE.exec(rest)
    if (ver) {
      if (ver[1] !== this.gameVersion) {
        this.gameVersion = ver[1]
        out.push({ ...base(), kind: 'gameVersion', version: ver[1] })
      }
      return out
    }

    const scene = SCENE_RE.exec(rest)
    if (scene) {
      out.push({ ...base(), kind: 'mapLoading', scenePath: scene[1] })
      return out
    }

    const net = NETGAME_RE.exec(rest)
    if (net) {
      const blob = net[1]
      out.push({
        ...base(),
        kind: 'raidMatched',
        location: field(blob, 'Location'),
        raidId: field(blob, 'shortId'),
        online: field(blob, 'RaidMode').toLowerCase() === 'online',
        gameMode: field(blob, 'GameMode'),
      })
      return out
    }

    if (rest.includes('|GameStarting:')) {
      out.push({ ...base(), kind: 'raidStarting' })
      return out
    }
    if (rest.includes('|GameStarted:')) {
      out.push({ ...base(), kind: 'raidStarted' })
      return out
    }
    if (rest.includes('Network game matching aborted') || rest.includes('Network game matching cancelled')) {
      out.push({ ...base(), kind: 'matchingAborted' })
      return out
    }

    if (rest.includes('Got notification | UserMatchOver')) {
      const j = parseJson(entry.json) as { location?: string; shortId?: string } | null
      out.push({ ...base(), kind: 'raidEnded', location: j?.location ?? '', raidId: j?.shortId ?? '' })
      return out
    }

    if (rest.includes('Got notification | RagfairNewRating')) {
      const j = parseJson(entry.json) as { rating?: number; isRatingGrowing?: boolean } | null
      if (typeof j?.rating === 'number') out.push({ ...base(), kind: 'fleaRating', rating: j.rating, growing: Boolean(j.isRatingGrowing) })
      return out
    }

    if (rest.includes('Got notification | ChatMessageReceived')) {
      const j = parseJson(entry.json) as ChatNotification | null
      const msg = j?.message
      if (!msg || typeof msg.type !== 'number') return out
      const templateId = typeof msg.templateId === 'string' ? msg.templateId : ''
      if (msg.type === MSG_TASK_STARTED || msg.type === MSG_TASK_FAILED || msg.type === MSG_TASK_FINISHED) {
        // Strict shape: "<24-hex quest id> <suffix for this message type>". Hand-in messages
        // (type 12) are only sent when the quest is turned in, never for single objectives.
        const [taskId, suffix] = templateId.split(' ')
        if (!taskId || !OBJECT_ID_RE.test(taskId) || suffix !== TASK_TEMPLATE_SUFFIX[msg.type]) return out
        const kind = msg.type === MSG_TASK_STARTED ? 'taskStarted' : msg.type === MSG_TASK_FAILED ? 'taskFailed' : 'taskFinished'
        out.push({ ...base(), kind, taskId, profileId: this.profileAt(entry.at), traderId: typeof msg.uid === 'string' ? msg.uid : null })
        return out
      }
      if (msg.type === MSG_FLEA) {
        const itemId = msg.systemData?.soldItem ?? ''
        const count = msg.systemData?.itemCount ?? 0
        if (templateId === FLEA_SOLD_TEMPLATE) {
          // What the buyer paid: money stacks attached to the message.
          let income = 0
          let currency: 'RUB' | 'USD' | 'EUR' | null = null
          for (const d of msg.items?.data ?? []) {
            const cur = d._tpl ? MONEY_TPL[d._tpl] : undefined
            if (!cur) continue
            currency = cur
            income += Number(d.upd?.StackObjectsCount ?? 1) || 0
          }
          out.push({ ...base(), kind: 'fleaSold', itemId, count, buyer: msg.systemData?.buyerNickname ?? '', income, currency })
        } else if (templateId === FLEA_EXPIRED_TEMPLATE) {
          out.push({ ...base(), kind: 'fleaExpired', itemId, count })
        }
        return out
      }
    }
    return out
  }
}

interface ChatNotification {
  message?: {
    type?: number
    templateId?: string
    uid?: string
    systemData?: { buyerNickname?: string; soldItem?: string; itemCount?: number }
    items?: { data?: { _tpl?: string; upd?: { StackObjectsCount?: number } }[] }
  }
}

function parseJson(text: string | null): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Which log files in a session folder are worth reading. */
export function logFileRole(fileName: string): 'application' | 'notifications' | null {
  const n = fileName.toLowerCase()
  if (!n.endsWith('.log')) return null
  if (/(^|[ _])application(_\d+)?\.log$/.test(n)) return 'application'
  if (/(^|[ _])(push-)?notifications(_\d+)?\.log$/.test(n)) return 'notifications'
  return null
}

/** Parses "log_2026.09.11_17-53-50_1.1.5.0.47242" into a sortable timestamp (ms) or null. */
export function logFolderTime(folderName: string): number | null {
  // The game writes the hour without a leading zero before 10:00 ("log_2026.10.07_5-48-13_…"):
  // with two digits required, morning sessions were invisible and the watcher stayed on the
  // previous folder.
  const m = /^log_(\d{4})\.(\d{1,2})\.(\d{1,2})_(\d{1,2})-(\d{1,2})-(\d{1,2})/.exec(folderName)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

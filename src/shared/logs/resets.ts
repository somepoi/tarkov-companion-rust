/**
 * Profile resets (a new wipe, or a PvE "reset profile") seen in the game logs. A reset keeps
 * the same profile id in PvE, and the logs have no explicit marker, but it leaves a clear
 * fingerprint: quests that were already handed in start again from the beginning. Several
 * of those within a few hours = a reset at the first one. A change of profile id in a mode
 * also starts a new period. Everything before the latest reset belongs to the old profile.
 */
import type { GameEvent, SessionMode } from '../desktop-api'

/** Restarted handed-in quests needed within RESET_WINDOW to call it a reset. */
const RESET_MIN_RESTARTS = 3
const RESET_WINDOW_MS = 6 * 3_600_000

/** Start of the current wipe/reset period per mode (ms), or null if the logs show none. */
export function detectResets(events: GameEvent[]): Record<SessionMode, number | null> {
  const out: Record<SessionMode, number | null> = { regular: null, pve: null, seasonal: null, unknown: null }
  const ordered = [...events].sort((a, b) => a.at - b.at)
  for (const mode of Object.keys(out) as SessionMode[]) {
    const finished = new Set<string>()
    let profile: string | null = null
    let restarts: number[] = []
    for (const e of ordered) {
      if (e.mode !== mode) continue
      if (e.kind === 'profile') {
        if (profile && e.profileId !== profile) {
          out[mode] = e.at
          finished.clear()
          restarts = []
        }
        profile = e.profileId
      } else if (e.kind === 'taskFinished') {
        finished.add(e.taskId)
      } else if (e.kind === 'taskStarted' && finished.has(e.taskId)) {
        restarts = [...restarts.filter((t) => e.at - t <= RESET_WINDOW_MS), e.at]
        if (restarts.length >= RESET_MIN_RESTARTS) {
          out[mode] = restarts[0]
          finished.clear()
          restarts = []
        }
      }
    }
  }
  return out
}

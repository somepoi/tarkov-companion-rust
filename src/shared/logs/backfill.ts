import type { BackfillResult, SessionMode } from '../desktop-api'
import { detectResets } from './resets'

export function emptyBackfill(): BackfillResult {
  return {
    folders: 0,
    files: 0,
    events: [],
    finishedByMode: { regular: [], pve: [], seasonal: [], unknown: [] },
    currentProfileByMode: {
      regular: null,
      pve: null,
      seasonal: null,
      unknown: null,
    },
    skippedOtherProfile: 0,
    sessions: [],
  }
}

/** Current-profile and wipe boundary rules shared by log backfill. */
export function finishBackfill(result: BackfillResult): BackfillResult {
  const ordered = [...result.events].sort((a, b) => a.at - b.at)
  const profilesSeen: Record<SessionMode, Set<string>> = {
    regular: new Set(),
    pve: new Set(),
    seasonal: new Set(),
    unknown: new Set(),
  }
  for (const event of ordered)
    if (event.kind === 'profile') {
      result.currentProfileByMode[event.mode] = event.profileId
      profilesSeen[event.mode].add(event.profileId)
    }
  const resets = detectResets(ordered)
  result.resetAtByMode = resets
  const finished: Record<SessionMode, Set<string>> = {
    regular: new Set(),
    pve: new Set(),
    seasonal: new Set(),
    unknown: new Set(),
  }
  for (const event of ordered)
    if (event.kind === 'taskFinished') {
      const current = result.currentProfileByMode[event.mode]
      const mine = event.profileId
        ? event.profileId === current
        : profilesSeen[event.mode].size <= 1
      if (mine && event.at >= (resets[event.mode] ?? -Infinity))
        finished[event.mode].add(event.taskId)
      else result.skippedOtherProfile++
    }
  for (const mode of Object.keys(finished) as SessionMode[])
    result.finishedByMode[mode] = [...finished[mode]]
  return result
}

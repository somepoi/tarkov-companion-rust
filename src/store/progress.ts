import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { GameMode } from '../api/client'
import { invalidateObjectiveProgress, objectiveFactToken, parseObjectiveProgress, progressKey,
  type ObjectiveProgress, type ObjectiveProgressFact } from '../lib/objectiveProgress'

export type Faction = 'USEC' | 'BEAR'

/** Progress is tracked separately per game mode, like the real game does. */
export interface Profile {
  playerLevel: number
  faction: Faction
  completedTaskIds: Set<string>
  /** Tasks the game log reported as started (accepted) and not yet finished/failed. */
  activeTaskIds: Set<string>
  /** Tasks the game log reported as failed. */
  failedTaskIds: Set<string>
  objectiveProgress?: ObjectiveProgress
  /** Invalid persisted input retained for export/recovery; never used as a counter. */
  objectiveProgressReview?: unknown
}

export const MIN_LEVEL = 1
export const MAX_LEVEL = 79

interface SerializedProfile {
  playerLevel: number
  faction: Faction
  completedTaskIds: string[]
  activeTaskIds?: string[]
  failedTaskIds?: string[]
  objectiveProgress?: ObjectiveProgress
  objectiveProgressReview?: unknown
}

export interface ProgressExport {
  app: 'tarkov-companion'
  version: 1
  exportedAt: string
  gameMode: GameMode
  profiles: Record<GameMode, SerializedProfile>
}

export interface ProgressState {
  gameMode: GameMode
  profiles: Record<GameMode, Profile>
  setGameMode: (mode: GameMode) => void
  setPlayerLevel: (level: number) => void
  setFaction: (faction: Faction) => void
  /** Active-mode helpers used by the UI. */
  setTaskCompleted: (taskId: string, completed: boolean) => void
  toggleTask: (taskId: string) => void
  /** Explicit-mode helpers used by the desktop log watcher. */
  setTaskCompletedFor: (mode: GameMode, taskId: string, completed: boolean) => void
  markTaskStartedFor: (mode: GameMode, taskId: string) => void
  markTaskFailedFor: (mode: GameMode, taskId: string) => void
  /** "I have this quest" (the game gave it to you) on or off, set by hand. */
  setTaskActiveFor: (mode: GameMode, taskId: string, active: boolean) => void
  setObjectiveProgressFor: (mode: GameMode, taskId: string, objectiveId: string,
    fact: ObjectiveProgressFact | null, expectedToken: string) => void
  clearObjectiveProgressFor: (mode: GameMode) => void
  /** Adds many completed tasks at once (backfill); returns how many were new. */
  addCompletedFor: (mode: GameMode, taskIds: string[]) => number
  /** Moves done/started/failed marks from one id to another (a wiki quest that the game data now has under its real id). */
  renameTasksFor: (mode: GameMode, ids: Record<string, string>) => void
  resetProgress: () => void
  exportProgress: () => ProgressExport
  /** Replaces all progress with the given export. Throws if the shape is invalid. */
  importProgress: (data: unknown) => void
}

const emptyProfile = (): Profile => ({
  playerLevel: 1,
  faction: 'USEC',
  completedTaskIds: new Set(),
  activeTaskIds: new Set(),
  failedTaskIds: new Set(),
  objectiveProgress: {},
})

const clampLevel = (n: number) =>
  Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.round(Number.isFinite(n) ? n : MIN_LEVEL)))

// --- Set <-> JSON helpers so the persisted state survives localStorage ----

interface SerializedSet {
  __type: 'Set'
  values: string[]
}

const isSerializedSet = (v: unknown): v is SerializedSet =>
  typeof v === 'object' &&
  v !== null &&
  (v as { __type?: unknown }).__type === 'Set' &&
  Array.isArray((v as { values?: unknown }).values)

const replacer = (_key: string, value: unknown): unknown =>
  value instanceof Set ? ({ __type: 'Set', values: Array.from(value) } satisfies SerializedSet) : value

const reviver = (_key: string, value: unknown): unknown =>
  isSerializedSet(value) ? new Set(value.values) : value

// --- Import validation --------------------------------------------------------

const isFaction = (v: unknown): v is Faction => v === 'USEC' || v === 'BEAR'
const isGameMode = (v: unknown): v is GameMode => v === 'regular' || v === 'pve'
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string')

function parseProfile(raw: unknown, label: string): Profile {
  if (typeof raw !== 'object' || raw === null) throw new Error(`Missing "${label}" profile.`)
  const p = raw as Record<string, unknown>
  if (typeof p.playerLevel !== 'number' || !Number.isFinite(p.playerLevel)) throw new Error(`"${label}.playerLevel" must be a number.`)
  if (!isFaction(p.faction)) throw new Error(`"${label}.faction" must be USEC or BEAR.`)
  if (!isStringArray(p.completedTaskIds)) throw new Error(`"${label}.completedTaskIds" must be a list of task ids.`)
  return {
    playerLevel: clampLevel(p.playerLevel),
    faction: p.faction,
    completedTaskIds: new Set(p.completedTaskIds),
    activeTaskIds: new Set(isStringArray(p.activeTaskIds) ? p.activeTaskIds : []),
    failedTaskIds: new Set(isStringArray(p.failedTaskIds) ? p.failedTaskIds : []),
    objectiveProgress: parseObjectiveProgress(p.objectiveProgress),
    objectiveProgressReview: p.objectiveProgressReview,
  }
}

export function parseProgressExport(data: unknown): { gameMode: GameMode; profiles: Record<GameMode, Profile> } {
  if (typeof data !== 'object' || data === null) throw new Error('File is not a JSON object.')
  const d = data as Record<string, unknown>
  if (d.app !== 'tarkov-companion') throw new Error('This file was not exported by Tarkov Companion.')
  if (typeof d.profiles !== 'object' || d.profiles === null) throw new Error('Missing "profiles".')
  const profiles = d.profiles as Record<string, unknown>
  return {
    gameMode: isGameMode(d.gameMode) ? d.gameMode : 'regular',
    profiles: {
      regular: parseProfile(profiles.regular, 'regular'),
      pve: parseProfile(profiles.pve, 'pve'),
    },
  }
}

// --- Store ----------------------------------------------------------------------

function withCompleted(p: Profile, taskId: string, completed: boolean): Profile {
  if (p.completedTaskIds.has(taskId) === completed && !(completed && (p.activeTaskIds.has(taskId) || p.failedTaskIds.has(taskId)))) return p
  const next = new Set(p.completedTaskIds)
  const active = new Set(p.activeTaskIds)
  const failed = new Set(p.failedTaskIds)
  if (completed) {
    next.add(taskId)
    active.delete(taskId)
    failed.delete(taskId)
  } else {
    next.delete(taskId)
  }
  return { ...p, completedTaskIds: next, activeTaskIds: active, failedTaskIds: failed }
}

/** The profile with every mark on an old id moved to its new id (unchanged object when nothing moves). */
export function withRenamed(p: Profile, ids: Record<string, string>): Profile {
  const move = (set: Set<string>) => {
    if (![...set].some((id) => id in ids)) return set
    return new Set([...set].map((id) => ids[id] ?? id))
  }
  const completedTaskIds = move(p.completedTaskIds)
  const activeTaskIds = move(p.activeTaskIds)
  const failedTaskIds = move(p.failedTaskIds)
  let objectiveProgress = p.objectiveProgress
  let objectiveProgressReview = p.objectiveProgressReview
  for (const [from, to] of Object.entries(ids)) {
    if (from === to || !progressKey(to) || !objectiveProgress?.[from]) continue
    const next = { ...objectiveProgress }
    if (Object.keys(next[from]).some((id) => next[to]?.[id]))
      objectiveProgressReview = { reason: 'Renamed objective counters conflict', sourceTaskId: from,
        targetTaskId: to, source: next[from], previous: objectiveProgressReview }
    // Keep both distinct objective IDs; any collision retains the target's fact.
    next[to] = { ...next[from], ...next[to] }
    delete next[from]
    objectiveProgress = invalidateObjectiveProgress(next, to)
  }
  if (completedTaskIds === p.completedTaskIds && activeTaskIds === p.activeTaskIds && failedTaskIds === p.failedTaskIds && objectiveProgress === p.objectiveProgress) return p
  const cleanActive = new Set(activeTaskIds)
  const cleanFailed = new Set(failedTaskIds)
  for (const id of completedTaskIds) {
    cleanActive.delete(id)
    cleanFailed.delete(id)
  }
  return { ...p, completedTaskIds, activeTaskIds: cleanActive, failedTaskIds: cleanFailed, objectiveProgress, objectiveProgressReview }
}

export const useProgressStore = create<ProgressState>()(
  persist(
    (set, get) => {
      const updateProfileFor = (mode: GameMode, fn: (p: Profile) => Profile) =>
        set((s) => {
          const nextProfile = fn(s.profiles[mode])
          if (nextProfile === s.profiles[mode]) return s
          return { profiles: { ...s.profiles, [mode]: nextProfile } }
        })
      const updateProfile = (fn: (p: Profile) => Profile) => updateProfileFor(get().gameMode, fn)

      return {
        gameMode: 'regular',
        profiles: { regular: emptyProfile(), pve: emptyProfile() },

        setGameMode: (gameMode) => set({ gameMode }),
        setPlayerLevel: (level) => updateProfile((p) => ({ ...p, playerLevel: clampLevel(level) })),
        setFaction: (faction) => updateProfile((p) => ({ ...p, faction })),
        setTaskCompleted: (taskId, completed) => updateProfile((p) => withCompleted(p, taskId, completed)),
        toggleTask: (taskId) => {
          const s = get()
          s.setTaskCompleted(taskId, !s.profiles[s.gameMode].completedTaskIds.has(taskId))
        },
        setTaskCompletedFor: (mode, taskId, completed) => updateProfileFor(mode, (p) => withCompleted(p, taskId, completed)),
        markTaskStartedFor: (mode, taskId) =>
          updateProfileFor(mode, (p) => {
            if (p.activeTaskIds.has(taskId) && !p.failedTaskIds.has(taskId)) return p
            const active = new Set(p.activeTaskIds)
            const failed = new Set(p.failedTaskIds)
            active.add(taskId)
            failed.delete(taskId)
            return { ...p, activeTaskIds: active, failedTaskIds: failed,
              objectiveProgress: invalidateObjectiveProgress(p.objectiveProgress, taskId) }
          }),
        setTaskActiveFor: (mode, taskId, on) =>
          updateProfileFor(mode, (p) => {
            if (p.activeTaskIds.has(taskId) === on && !(on && p.failedTaskIds.has(taskId))) return p
            const active = new Set(p.activeTaskIds)
            const failed = new Set(p.failedTaskIds)
            if (on) { active.add(taskId); failed.delete(taskId) }
            else active.delete(taskId)
            return { ...p, activeTaskIds: active, failedTaskIds: failed,
              objectiveProgress: invalidateObjectiveProgress(p.objectiveProgress, taskId) }
          }),
        markTaskFailedFor: (mode, taskId) =>
          updateProfileFor(mode, (p) => {
            if (p.failedTaskIds.has(taskId) && !p.activeTaskIds.has(taskId)) return p
            const active = new Set(p.activeTaskIds)
            const failed = new Set(p.failedTaskIds)
            active.delete(taskId)
            failed.add(taskId)
            return { ...p, activeTaskIds: active, failedTaskIds: failed,
              objectiveProgress: invalidateObjectiveProgress(p.objectiveProgress, taskId) }
          }),
        setObjectiveProgressFor: (mode, taskId, objectiveId, fact, expectedToken) =>
          updateProfileFor(mode, (p) => {
            if (!progressKey(taskId) || !progressKey(objectiveId)) throw new Error('Invalid objective identity')
            const existing = p.objectiveProgress?.[taskId]?.[objectiveId]
            if (objectiveFactToken(existing) !== expectedToken) throw new Error('Saved objective progress changed. Reload it before saving.')
            if (fact && (!p.activeTaskIds.has(taskId) || p.failedTaskIds.has(taskId) || p.completedTaskIds.has(taskId)))
              throw new Error('Only an active, unfinished quest can receive current partial progress')
            const objectives = { ...p.objectiveProgress?.[taskId] }
            if (fact) objectives[objectiveId] = fact
            else delete objectives[objectiveId]
            const facts = { ...p.objectiveProgress }
            if (Object.keys(objectives).length) facts[taskId] = objectives
            else delete facts[taskId]
            return { ...p, objectiveProgress: parseObjectiveProgress(facts) }
          }),
        clearObjectiveProgressFor: (mode) => updateProfileFor(mode, (p) => ({
          ...p, objectiveProgress: {}, objectiveProgressReview: undefined,
        })),
        addCompletedFor: (mode, taskIds) => {
          let added = 0
          updateProfileFor(mode, (p) => {
            const fresh = taskIds.filter((id) => !p.completedTaskIds.has(id))
            added = fresh.length
            if (fresh.length === 0) return p
            const next = new Set(p.completedTaskIds)
            const active = new Set(p.activeTaskIds)
            const failed = new Set(p.failedTaskIds)
            for (const id of fresh) {
              next.add(id)
              active.delete(id)
              failed.delete(id)
            }
            return { ...p, completedTaskIds: next, activeTaskIds: active, failedTaskIds: failed }
          })
          return added
        },
        renameTasksFor: (mode, ids) => updateProfileFor(mode, (p) => withRenamed(p, ids)),
        resetProgress: () => updateProfile(() => emptyProfile()),

        exportProgress: () => {
          const s = get()
          const serialize = (p: Profile): SerializedProfile => ({
            playerLevel: p.playerLevel,
            faction: p.faction,
            completedTaskIds: Array.from(p.completedTaskIds),
            activeTaskIds: Array.from(p.activeTaskIds),
            failedTaskIds: Array.from(p.failedTaskIds),
            objectiveProgress: parseObjectiveProgress(p.objectiveProgress),
            objectiveProgressReview: p.objectiveProgressReview,
          })
          return {
            app: 'tarkov-companion',
            version: 1,
            exportedAt: new Date().toISOString(),
            gameMode: s.gameMode,
            profiles: { regular: serialize(s.profiles.regular), pve: serialize(s.profiles.pve) },
          }
        },
        importProgress: (data) => {
          const parsed = parseProgressExport(data)
          set({ gameMode: parsed.gameMode, profiles: parsed.profiles })
        },
      }
    },
    {
      name: 'tarkov-companion-progress',
      version: 3,
      storage: createJSONStorage(() => localStorage, { replacer, reviver }),
      // Older optional fields are filled by merge; never discard the old profile.
      // Without a migrate function zustand would throw the old state away.
      migrate: (persisted) => persisted as ProgressState,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<ProgressState>
        const mergeProfile = (base: Profile, stored?: Partial<Profile>): Profile => {
          let objectiveProgress: ObjectiveProgress = {}
          let objectiveProgressReview = stored?.objectiveProgressReview
          try { objectiveProgress = parseObjectiveProgress(stored?.objectiveProgress) } catch {
            objectiveProgressReview = { unparsed: stored?.objectiveProgress, previous: objectiveProgressReview }
          }
          return {
          ...base,
          ...(stored ?? {}),
          completedTaskIds: stored?.completedTaskIds instanceof Set ? stored.completedTaskIds : base.completedTaskIds,
          activeTaskIds: stored?.activeTaskIds instanceof Set ? stored.activeTaskIds : new Set(),
          failedTaskIds: stored?.failedTaskIds instanceof Set ? stored.failedTaskIds : new Set(),
          objectiveProgress,
          objectiveProgressReview,
          }
        }
        return {
          ...current,
          gameMode: isGameMode(p.gameMode) ? p.gameMode : current.gameMode,
          profiles: {
            regular: mergeProfile(current.profiles.regular, p.profiles?.regular),
            pve: mergeProfile(current.profiles.pve, p.profiles?.pve),
          },
        }
      },
    },
  ),
)

/** The profile for the currently selected game mode. */
export const useProfile = (): Profile => useProgressStore((s) => s.profiles[s.gameMode])

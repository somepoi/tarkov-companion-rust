import { useCallback, useMemo, useState } from 'react'
import { Check, Clock, Lock } from 'lucide-react'
import { useGameData, useHideout, useItems } from '../api/hooks'
import type { HideoutLevel, HideoutStation } from '../api/types'
import { ErrorPanel, LoadingPanel } from '../components/DataState'
import { SegmentButton } from '../components/SegmentButton'
import { BunkerView } from '../hideout/BunkerView'
import { useProgressContext } from '../hooks/useProgressContext'
import { formatDuration } from '../lib/economy'
import { bonusText, stationInfo } from '../lib/hideoutState'
import { useHideoutTimers } from '../store/hideoutTimers'
import { useInventoryStore, useModeInventory } from '../store/inventory'
import { useProgressStore } from '../store/progress'

type View = 'bunker' | 'stations' | 'build'
const VIEW_KEY = 'tc-hideout-view'
function loadView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'stations' || v === 'build' ? v : 'bunker'
  } catch {
    return 'bunker'
  }
}

interface NextLevelInfo {
  station: HideoutStation
  level: HideoutLevel
  /** Station prerequisites not yet met: "Generator level 2". */
  blockedBy: string[]
  prereqsMet: boolean
  depth: number
}

function LevelRequirements({ level, stations, stationLevels, traderName, items, collected }: {
  level: HideoutLevel
  stations: Record<string, HideoutStation>
  stationLevels: Record<string, number>
  traderName: (id: string) => string
  items: ReturnType<typeof useItems>['data']
  collected: Record<string, number>
}) {
  return (
    <div className="space-y-2 text-xs">
      {level.itemRequirements.length > 0 && (
        <ul className="grid grid-cols-1 gap-1 sm:grid-cols-2">
          {level.itemRequirements.map((r) => {
            const item = items?.items[r.itemId]
            const have = collected[r.itemId] ?? 0
            return (
              <li key={r.itemId + r.count} className="flex items-center gap-2 rounded bg-surface px-2 py-1">
                {item?.iconLink && <img src={item.iconLink} alt="" className="h-6 w-6 object-contain" loading="lazy" />}
                <span className="min-w-0 flex-1 truncate">{item?.name ?? '…'}</span>
                <span className={`tabular-nums ${r.count !== null && have >= r.count && (r.count === 0 || r.foundInRaid === false) ? 'text-success' : 'text-ink-muted'}`}>{r.count === null ? `${have}/?` : `${Math.min(have, r.count)}/${r.count}`}{r.foundInRaid === true ? ' FIR' : r.foundInRaid === null ? ' · FIR unknown' : ''}</span>
              </li>
            )
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-ink-muted">
        {level.stationLevelRequirements.map((r) => {
          const met = (stationLevels[r.stationId] ?? 0) >= r.level
          return (
            <span key={r.stationId} className={met ? 'text-success' : 'text-danger'}>
              {met ? <Check className="mr-0.5 inline h-3 w-3" /> : <Lock className="mr-0.5 inline h-3 w-3" />}
              {stations[r.stationId]?.name ?? 'Station'} {r.level}
            </span>
          )
        })}
        {level.traderRequirements.map((r, i) => (
          <span key={i}>{traderName(r.traderId)} LL{r.level}</span>
        ))}
        {level.skillRequirements.map((r, i) => (
          <span key={i}>{r.skill} {r.level}</span>
        ))}
        <span><Clock className="mr-0.5 inline h-3 w-3" />{formatDuration(level.constructionTime)}</span>
      </div>
      {level.bonuses.length > 0 && (
        <div className="text-ink-dim">
          Gives: {level.bonuses.map(bonusText).join(' · ')}
        </div>
      )}
    </div>
  )
}

export function HideoutPage() {
  const hideout = useHideout()
  const items = useItems()
  const gameData = useGameData()
  const gameMode = useProgressStore((s) => s.gameMode)
  const inventory = useModeInventory()
  const setStationLevel = useInventoryStore((s) => s.setStationLevel)
  const setCollectedFor = useInventoryStore((s) => s.setCollected)
  const clearTimer = useHideoutTimers((s) => s.clear)
  const progress = useProgressContext()
  const [view, setViewState] = useState<View>(loadView)
  const setView = (v: View) => {
    setViewState(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* private window: only this visit */
    }
  }
  // Setting a level by hand ends that station's build timer.
  const setLevel = useCallback(
    (stationId: string, level: number) => {
      setStationLevel(gameMode, stationId, level)
      clearTimer(gameMode, stationId)
    },
    [gameMode, setStationLevel, clearTimer],
  )
  const setCollected = useCallback((itemId: string, count: number) => setCollectedFor(gameMode, itemId, count), [gameMode, setCollectedFor])
  // Both native and web catalogs can repeat a station's previous level. It's implicit in
  // the level being upgraded, so remove it from the display without changing planner data.
  const stations = useMemo(
    () => (hideout.data ?? []).map((station) => ({
      ...station,
      levels: station.levels.map((level) => ({
        ...level,
        stationLevelRequirements: level.stationLevelRequirements.filter((requirement) => requirement.stationId !== station.id),
      })),
    })),
    [hideout.data],
  )
  const infos = useMemo(
    () => stationInfo(stations, inventory.stationLevels, inventory.collected, progress?.traderLevel ?? null),
    [stations, inventory.stationLevels, inventory.collected, progress?.traderLevel],
  )

  const stationsById = useMemo(() => Object.fromEntries(stations.map((s) => [s.id, s])), [stations])
  const traderName = (id: string) => gameData.data?.traders.find((t) => t.id === id)?.name ?? 'Trader'

  const nextLevels = useMemo<NextLevelInfo[]>(() => {
    const levels = inventory.stationLevels
    const out: NextLevelInfo[] = []
    // depth = how many station upgrades must happen before this one (rough ordering)
    const depthOf = (level: HideoutLevel, seen = new Set<string>()): number => {
      let d = 0
      for (const r of level.stationLevelRequirements) {
        const cur = levels[r.stationId] ?? 0
        if (cur >= r.level) continue
        const st = stationsById[r.stationId]
        if (!st || seen.has(`${r.stationId}:${r.level}`)) continue
        seen.add(`${r.stationId}:${r.level}`)
        const lv = st.levels.find((l) => l.level === r.level)
        d = Math.max(d, (r.level - cur) + (lv ? depthOf(lv, seen) : 0))
      }
      return d
    }
    for (const station of stations) {
      const cur = levels[station.id] ?? 0
      const next = station.levels.find((l) => l.level === cur + 1)
      if (!next) continue
      const blockedBy = next.stationLevelRequirements
        .filter((r) => (levels[r.stationId] ?? 0) < r.level)
        .map((r) => `${stationsById[r.stationId]?.name ?? 'Station'} ${r.level}`)
      out.push({ station, level: next, blockedBy, prereqsMet: blockedBy.length === 0, depth: depthOf(next) })
    }
    return out.sort((a, b) => Number(!a.prereqsMet) - Number(!b.prereqsMet) || a.depth - b.depth || a.station.name.localeCompare(b.station.name))
  }, [stations, inventory.stationLevels, stationsById])

  if (hideout.isPending) return <LoadingPanel label="hideout" />
  if (hideout.isError && !hideout.data) return <ErrorPanel error={hideout.error} onRetry={() => void hideout.refetch()} />
  const builtLevels = stations.reduce((n, s) => n + (inventory.stationLevels[s.id] ?? 0), 0)
  const totalLevels = stations.reduce((n, s) => n + s.levels.length, 0)

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Hideout</h1>
          <p className="text-sm text-ink-muted">
            {view === 'bunker'
              ? `Your ${gameMode === 'pve' ? 'PvE' : 'PvP'} bunker. Click a station to set its level, see what the next one needs and start a build timer.`
              : `Set each station's current level (${gameMode === 'pve' ? 'PvE' : 'PvP'}). Items for the next levels appear in Item Collection automatically. ${builtLevels}/${totalLevels} levels built.`}
          </p>
        </div>
        <div className="flex rounded border border-line bg-surface-2 p-0.5" role="group" aria-label="View">
          <SegmentButton label="Bunker" active={view === 'bunker'} onClick={() => setView('bunker')} />
          <SegmentButton label="Stations" active={view === 'stations'} onClick={() => setView('stations')} />
          <SegmentButton label="Build order" active={view === 'build'} onClick={() => setView('build')} />
        </div>
      </div>

      {view === 'bunker' ? (
        <BunkerView
          stations={stations}
          infos={infos}
          gameMode={gameMode}
          items={items.data?.items}
          traders={gameData.data?.traders ?? []}
          traderLevel={progress?.traderLevel ?? null}
          collected={inventory.collected}
          setLevel={setLevel}
          setCollected={setCollected}
        />
      ) : view === 'stations' ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {stations.map((station) => {
            const cur = inventory.stationLevels[station.id] ?? 0
            const max = station.levels.length ? Math.max(...station.levels.map((l) => l.level)) : 0
            const next = station.levels.find((l) => l.level === cur + 1)
            return (
              <div key={station.id} className="card">
                <div className="flex items-center gap-3">
                  {station.imageLink && <img src={station.imageLink} alt="" className="h-9 w-9 object-contain" loading="lazy" />}
                  <div className="min-w-0 flex-1">
                    <h2 className="font-semibold">{station.name}</h2>
                    <p className="text-xs text-ink-muted">{cur >= max ? 'Fully upgraded' : next ? `Next: level ${next.level}` : ''}</p>
                  </div>
                  <label className="flex items-center gap-1.5 text-xs text-ink-muted">
                    Level
                    <select value={cur} onChange={(e) => setLevel(station.id, Number(e.target.value))} aria-label={`${station.name} level`} className="rounded border border-line bg-surface px-2 py-1 text-sm text-ink focus:border-accent focus:outline-none">
                      {Array.from({ length: max + 1 }, (_, i) => (
                        <option key={i} value={i}>{i}</option>
                      ))}
                    </select>
                  </label>
                </div>
                {next && (
                  <div className="mt-3">
                    <LevelRequirements level={next} stations={stationsById} stationLevels={inventory.stationLevels} traderName={traderName} items={items.data} collected={inventory.collected} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="mt-4 overflow-hidden rounded-lg border border-line bg-surface-2">
          <p className="border-b border-line px-4 py-2 text-xs text-ink-muted">
            Next level of every station, buildable ones first. "Buildable now" means the other stations it depends on are at the required level; trader loyalty and skills are listed but not tracked.
          </p>
          <ul className="divide-y divide-line">
            {nextLevels.map((n) => (
              <li key={n.level.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{n.station.name} → level {n.level.level}</span>
                  {n.prereqsMet ? (
                    <span className="rounded border border-success/60 bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-success">Buildable now</span>
                  ) : (
                    <span className="rounded border border-line bg-surface px-1.5 py-0.5 text-[10px] uppercase text-ink-muted">Needs {n.blockedBy.join(', ')}</span>
                  )}
                  <button type="button" onClick={() => setLevel(n.station.id, n.level.level)} className="btn ml-auto !px-2 !py-0.5 !text-[11px]">
                    <Check className="h-3.5 w-3.5" /> Mark built
                  </button>
                </div>
                <div className="mt-2">
                  <LevelRequirements level={n.level} stations={stationsById} stationLevels={inventory.stationLevels} traderName={traderName} items={items.data} collected={inventory.collected} />
                </div>
              </li>
            ))}
            {nextLevels.length === 0 && <li className="px-4 py-8 text-center text-sm text-ink-muted">Every station is fully upgraded.</li>}
          </ul>
        </div>
      )}
    </div>
  )
}

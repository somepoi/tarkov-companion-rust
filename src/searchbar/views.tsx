import { useMemo, useState } from 'react'
import { Check, ExternalLink, Map as MapIcon } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import type { Task } from '../api/types'
import { useStory, type StoryData } from '../api/storyWiki'
import { bestArmorClass, caliberLabel, shotDamage } from '../lib/ammo'
import { acquireCost, formatDuration } from '../lib/economy'
import { usePrefs } from '../store/prefs'
import { formatRoubles } from '../lib/format'
import { isFactionEligible } from '../lib/taskStatus'
import { buildSpawnModel } from '../maps/overlay/spawns'
import { pictureThumb, wikiPageUrl } from '../maps/overlay/bossAreas'
import { BOSS_INFO } from '../maps/overlay/bossInfo'
import { spotSource } from '../maps/overlay/bossSpots'
import type { GuideImage } from '../api/wikiGuide'
import { requiredClosure, topoOrder } from '../quests/questGraph'
import { useInventoryStore } from '../store/inventory'
import { useProfile } from '../store/progress'
import { useStoryStore } from '../store/story'
import { ActionButton, ItemLink, Pictures, QuestLink, Section, StarButton, Stepper, WikiCredit } from './details'
import { useDetails } from './detailsContext'
import { bossIndex, clock, questline } from './overlayLogic'
import { nextLoyalty } from '../lib/progression'
import { useNow } from './shell'
import { buildUnlocks } from '../quests/questGraph'

const Heading = ({ children }: { children: React.ReactNode }) => <div className="font-medium leading-snug">{children}</div>
const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-xs text-white/55">{children}</p>

// ---------------------------------------------------------------------------

export function QuestlineView({ id }: { id: string }) {
  const c = useDetails()
  const task = c.data.tasksById[id]
  const unlocks = useMemo(() => buildUnlocks(c.data.tasks), [c.data.tasks])
  const line = useMemo(() => questline(id, c.data.tasksById, unlocks), [id, c.data.tasksById, unlocks])
  if (!task) return <Muted>Not in the data any more.</Muted>
  const todo = line.before.filter((s) => !c.completed.has(s.task.id)).length
  const before = [...line.before].sort((a, b) => b.depth - a.depth)
  return (
    <>
      <Heading>Questline: {task.name}</Heading>
      <Muted>{todo ? `${todo} quest${todo === 1 ? '' : 's'} still to do before it.` : line.before.length ? 'Everything before it is done.' : 'Nothing comes before it.'}</Muted>
      <ol className="mt-1.5 space-y-0.5">
        {before.map((s) => (
          <li key={s.task.id} style={{ paddingLeft: Math.min(4, s.depth - 1) * 6 }}>
            <QuestLink task={s.task} />
          </li>
        ))}
        <li className="rounded bg-white/10 px-1 py-0.5">
          <QuestLink task={task} note="this one" />
        </li>
        {line.after.map((s) => (
          <li key={s.task.id} style={{ paddingLeft: Math.min(4, s.depth) * 6 }}>
            <QuestLink task={s.task} note={s.depth === 1 ? 'opens next' : undefined} />
          </li>
        ))}
      </ol>
      {line.after.length === 0 && <Muted>It opens no further quests.</Muted>}
    </>
  )
}

// ---------------------------------------------------------------------------

export function TraderView({ id }: { id: string }) {
  const c = useDetails()
  const setLevel = useInventoryStore((s) => s.setTraderLevel)
  const now = useNow(1000)
  const trader = c.data.traders.find((t) => t.id === id)
  const tasks = useMemo(() => c.data.tasks.filter((t) => t.trader.id === id && c.statuses[t.id]), [c.data.tasks, c.statuses, id])
  if (!trader) return <Muted>Not in the data any more.</Muted>
  const by = (s: string) => tasks.filter((t) => c.statuses[t.id] === s)
  const available = by('available')
  const locked = by('locked')
  const done = by('completed')
  const level = c.traderLevels[id] ?? 1
  const calc = c.progress?.calculatedTraderLevel[id] ?? 1
  const rep = c.progress?.reputation[id] ?? 0
  const next = c.progress ? nextLoyalty(trader, level, c.progress.level, rep) : null
  return (
    <>
      <div className="flex items-center gap-2">
        {trader.imageLink && <img src={trader.imageLink} alt="" className="h-10 w-10 rounded object-cover" />}
        <div className="min-w-0 flex-1">
          <Heading>{trader.name}</Heading>
          <Muted>{trader.resetTime ? `Restock in ${clock(Math.max(0, (trader.resetTime - now) / 1000))}` : 'No restock time in the data'}</Muted>
        </div>
        <StarButton r={{ kind: 'trader', id, label: trader.name }} />
      </div>
      {trader.maxLevel > 1 && (
        <div className="mt-1.5 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-white/55">Loyalty level</span>
            <Stepper value={level} min={1} max={trader.maxLevel} label="Loyalty level" onChange={(n) => setLevel(c.mode, id, n <= calc ? 0 : n)} />
            <span className="text-white/45">{level > calc ? 'set by you' : 'from your quests'}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-white/55">
            Reputation {rep.toFixed(2)} from finished quests{c.progress ? `, level ${c.progress.level}` : ''} → LL{calc}.
            {next ? ` LL${next.level} needs level ${next.playerLevel} and reputation ${next.reputation}${next.needLevel || next.needReputation ? ` (${[next.needLevel ? `${next.needLevel} more levels` : '', next.needReputation ? `${next.needReputation.toFixed(2)} more reputation` : ''].filter(Boolean).join(', ')})` : ''}.` : ''}
            {' '}Daily quests are not counted: raise it with + if yours is higher.
          </p>
        </div>
      )}
      <div className="mt-1.5 text-xs text-white/70">
        {available.length} available · {locked.length} locked · {done.length} done
      </div>
      <Section title="Available now" count={available.length} defaultOpen>
        <ul className="space-y-0.5">
          {available.map((t) => (
            <li key={t.id}>
              <QuestLink task={t} note={t.map?.name ?? ''} />
            </li>
          ))}
        </ul>
      </Section>
      {locked.length > 0 && (
        <Section title="Locked" count={locked.length}>
          <ul className="space-y-0.5">
            {locked.slice(0, 60).map((t) => (
              <li key={t.id}>
                <QuestLink task={t} note={t.minPlayerLevel > 1 ? `lvl ${t.minPlayerLevel}` : ''} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}

export function TradersView() {
  const c = useDetails()
  const now = useNow(1000)
  const traders = [...c.data.traders].filter((t) => t.resetTime).sort((a, b) => (a.resetTime ?? 0) - (b.resetTime ?? 0))
  return (
    <>
      <Heading>Trader restocks</Heading>
      <ul className="mt-1.5 space-y-0.5">
        {traders.map((t) => {
          const left = Math.max(0, ((t.resetTime ?? 0) - now) / 1000)
          return (
            <li key={t.id}>
              <button type="button" onClick={() => c.open({ kind: 'trader', id: t.id })} className="flex w-full items-center gap-2 text-left hover:text-white">
                {t.imageLink && <img src={t.imageLink} alt="" className="h-6 w-6 rounded object-cover" />}
                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                <span className={`tabular-nums ${left < 600 ? 'text-green-300' : 'text-white/70'}`}>{clock(left)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <Muted>Restock times come with the game data (refreshed every few hours).</Muted>
    </>
  )
}

// ---------------------------------------------------------------------------

export function BossView({ id }: { id: string }) {
  const c = useDetails()
  const boss = useMemo(() => bossIndex(c.data).find((b) => b.key === id), [c.data, id])
  // One spawn model per map the boss is on: its spots checked against where players report it.
  const perMap = useMemo(
    () => (boss?.maps ?? []).map((m) => ({ ...m, entry: buildSpawnModel(c.data, m.mapId).bosses.find((b) => b.key === id) })),
    [c.data, boss, id],
  )
  // Guards and conditions from the most likely map that has spots (Knight: Customs, not Icebreaker's scripted squad).
  const detail = (perMap.find((m) => m.entry?.spots.length) ?? perMap[0])?.entry
  const detailMap = (perMap.find((m) => m.entry?.spots.length) ?? perMap[0])?.mapId
  const pictures = useMemo(() => {
    const seen = new Set<string>()
    const out: GuideImage[] = []
    for (const m of perMap)
      for (const a of m.entry?.areas ?? []) {
        if (!a.picture || seen.has(a.picture)) continue
        seen.add(a.picture)
        // 1600 px: the originals are up to 7000 px (≈190 MB decoded in the search bar).
        out.push({ full: pictureThumb(a, 1600), thumb: pictureThumb(a), caption: `${a.pictureFile} (EFT Wiki, ${a.pictureDate.slice(0, 7)})`, section: 'Boss' })
      }
    return out
  }, [perMap])
  if (!boss) return <Muted>Not in the data any more.</Muted>
  const mapName = (mapId: string) => c.data.maps.find((m) => m.id === mapId)?.name ?? 'Map'
  const pages = [...new Set(perMap.flatMap((m) => m.entry?.areas.map((a) => a.page) ?? []))]
  return (
    <>
      <div className="flex items-center gap-2">
        {boss.portrait && <img src={boss.portrait} alt="" className="h-10 w-10 rounded-full object-cover" />}
        <Heading>{boss.name}</Heading>
        <span className="flex-1" />
        <StarButton r={{ kind: 'boss', id, label: boss.name }} />
      </div>
      <ul className="mt-1.5 space-y-1">
        {perMap.map((m) => {
          const spots = m.entry?.spots ?? []
          const shown = spots.filter((s) => s.kind !== 'data')
          const dataOnly = spots.filter((s) => s.kind === 'data').reduce((n, s) => n + s.points.length, 0)
          const pts = shown.map((s) => s.centre)
          const fit = [...(m.entry?.areas.flatMap((a) => a.polygon.map(([x, z]) => ({ x, y: 0, z }))) ?? []), ...shown.flatMap((s) => s.points)]
          return (
            <li key={m.mapId} className="text-xs">
              <div className="flex items-center gap-2">
                <span className="w-10 shrink-0 tabular-nums text-white/70">{Math.round(m.chance * 100)}%</span>
                <span className="min-w-0 flex-1 truncate">{mapName(m.mapId)}</span>
                {pts.length > 0 ? (
                  <ActionButton onClick={() => c.openMap(m.mapId, { layers: ['bosses'], spot: { points: pts, label: boss.name, fit }, title: `${boss.name} on ${mapName(m.mapId)}` })}>
                    <MapIcon className="h-3 w-3" /> Spawns
                  </ActionButton>
                ) : (
                  <span className="text-[10px] text-white/40">no spots in the data</span>
                )}
              </div>
              {shown.length > 0 && (
                <ul className="ml-12 mt-0.5 space-y-px text-[11px] text-white/65">
                  {shown.map((s) => (
                    <li key={s.key} title={m.entry ? spotSource(s, boss.name) : undefined}>
                      <span className={s.kind === 'reported' ? 'text-white/85' : ''}>{s.kind === 'reported' ? '◌ ' : ''}{s.name}</span>
                      {s.share > 0 ? <span className="text-white/45"> · {Math.round(s.share * 100)}%</span> : <span className="text-white/35"> · players report it; no data points</span>}
                    </li>
                  ))}
                </ul>
              )}
              {dataOnly > 0 && <p className="ml-12 text-[10px] text-white/35">+{dataOnly} point{dataOnly === 1 ? '' : 's'} only in the game data, away from where players report {boss.name}</p>}
              {m.entry?.note && <p className="ml-12 text-[11px] text-amber-300/90">{m.entry.note}</p>}
            </li>
          )
        })}
      </ul>
      {BOSS_INFO[id] && (
        <Section title={BOSS_INFO[id].members ? 'How they behave' : 'How it behaves'} count={BOSS_INFO[id].behaviour.length} defaultOpen>
          {BOSS_INFO[id].members && <p className="text-xs text-white/70">{BOSS_INFO[id].members}.</p>}
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-white/80">
            {BOSS_INFO[id].behaviour.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <WikiCredit url={wikiPageUrl(BOSS_INFO[id].page)} />
        </Section>
      )}
      {pictures.length > 0 && (
        <Section title="Where players report it" count={pictures.length}>
          <Pictures images={pictures} title={`${boss.name}: EFT Wiki maps`} />
          <p className="mt-1 text-[11px] text-white/50">◌ spots are these marked areas, fitted to the map with the extracts they show (±7–18 m).</p>
          {pages.map((pg) => (
            <WikiCredit key={pg} url={wikiPageUrl(pg)} />
          ))}
        </Section>
      )}
      {detail && detail.escorts.length > 0 && <p className="mt-1.5 text-xs text-white/70">Guards{perMap.length > 1 && detailMap ? ` on ${mapName(detailMap)}` : ''}: {detail.escorts.map((x) => `${x.name} ×${x.counts.join('/') || '?'}`).join(', ')}</p>}
      {detail?.conditions.map((t) => (
        <p key={t} className="text-xs text-white/55">{t}</p>
      ))}
      <Muted>Chances and spawn points are tarkov.dev's game data; ◌ areas are from the EFT Wiki's maps. % = its share of that map's spawn chance (game data), given to the area that zone stands for.</Muted>
    </>
  )
}

// ---------------------------------------------------------------------------

export function StationView({ id }: { id: string }) {
  const c = useDetails()
  const setLevel = useInventoryStore((s) => s.setStationLevel)
  const station = c.stations.find((s) => s.id === id)
  if (!station) return <Muted>The hideout data is still loading.</Muted>
  const current = c.stationLevels[id] ?? 0
  const max = station.levels.length
  const next = station.levels.find((l) => l.level === current + 1)
  const stationName = (sid: string) => c.stations.find((s) => s.id === sid)?.name ?? 'Station'
  return (
    <>
      <div className="flex items-center gap-2">
        {station.imageLink && <img src={station.imageLink} alt="" className="h-9 w-9 object-contain" />}
        <Heading>{station.name}</Heading>
        <span className="flex-1" />
        <StarButton r={{ kind: 'station', id, label: station.name }} />
      </div>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        <span className="text-white/55">Built level</span>
        <Stepper value={current} min={0} max={max} label="Station level" onChange={(n) => setLevel(c.mode, id, n)} />
        <span className="text-white/45">of {max}</span>
      </div>
      {!next ? (
        <p className="mt-1.5 text-xs text-green-300">Fully built.</p>
      ) : (
        <>
          <div className="mt-1.5 text-xs text-white/70">
            Level {next.level} · builds in {formatDuration(next.constructionTime)}
          </div>
          <ul className="mt-1 space-y-0.5">
            {next.itemRequirements.map((r) => {
              const have = c.collected[r.itemId] ?? 0
              return (
                <li key={r.itemId} className="flex items-center gap-1.5">
                  <span className={`w-14 shrink-0 tabular-nums text-xs ${r.count !== null && have >= r.count ? 'text-green-300' : 'text-white/60'}`}>
                    {r.count === null ? `${have}/?` : `${Math.min(have, r.count)}/${formatCount(r.count)}`}
                  </span>
                  <ItemLink id={r.itemId} />
                  {r.foundInRaid !== false && <span className="shrink-0 text-[10px] text-amber-300">{r.foundInRaid === true ? 'FIR' : 'FIR unknown'}</span>}
                </li>
              )
            })}
            {next.traderRequirements.map((r) => (
              <li key={r.traderId} className="text-xs text-white/70">
                {c.traderName(r.traderId)} loyalty {r.level} {(c.traderLevels[r.traderId] ?? 1) >= r.level ? '✓' : ''}
              </li>
            ))}
            {next.stationLevelRequirements.map((r) => (
              <li key={r.stationId} className="text-xs text-white/70">
                {stationName(r.stationId)} level {r.level} {(c.stationLevels[r.stationId] ?? 0) >= r.level ? '✓' : ''}
              </li>
            ))}
            {next.skillRequirements.map((r) => (
              <li key={r.skill} className="text-xs text-white/70">
                {r.skill} skill {r.level}
              </li>
            ))}
          </ul>
          {next.bonuses.length > 0 && <p className="mt-1 text-[11px] text-white/50">Gives: {next.bonuses.map((b) => b.name).join(', ')}</p>}
        </>
      )}
    </>
  )
}

const formatCount = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n))

/** Every station: built level, and whether the next level can be built with what you have. */
export function HideoutView() {
  const c = useDetails()
  const rows = useMemo(
    () =>
      c.stations
        .map((s) => {
          const level = c.stationLevels[s.id] ?? 0
          const next = s.levels.find((l) => l.level === level + 1)
          const missing = next
            ? next.itemRequirements.filter((r) => r.count === null || (c.collected[r.itemId] ?? 0) < r.count).length +
              next.stationLevelRequirements.filter((r) => (c.stationLevels[r.stationId] ?? 0) < r.level).length +
              next.traderRequirements.filter((r) => (c.traderLevels[r.traderId] ?? 1) < r.level).length
            : 0
          return { s, level, max: s.levels.length, next, missing }
        })
        .sort((a, b) => Number(!a.next) - Number(!b.next) || a.missing - b.missing || a.s.name.localeCompare(b.s.name)),
    [c.stations, c.stationLevels, c.collected, c.traderLevels],
  )
  if (!c.stations.length) return <Muted>The hideout data is still loading.</Muted>
  return (
    <>
      <Heading>Hideout</Heading>
      <Muted>Levels and items as set in the app (Hideout tab, Item Collection). Skills are not counted.</Muted>
      <ul className="mt-1.5 space-y-0.5">
        {rows.map(({ s, level, max, next, missing }) => (
          <li key={s.id}>
            <button type="button" onClick={() => c.open({ kind: 'station', id: s.id })} className="flex w-full items-center gap-2 text-left hover:text-white">
              {s.imageLink ? <img src={s.imageLink} alt="" className="h-5 w-5 shrink-0 object-contain" /> : <span className="h-5 w-5 shrink-0" />}
              <span className="min-w-0 flex-1 truncate">{s.name}</span>
              <span className="shrink-0 text-[11px] tabular-nums text-white/50">
                {level}/{max}
              </span>
              <span className={`w-24 shrink-0 text-right text-[11px] ${!next ? 'text-white/40' : missing === 0 ? 'text-green-300' : 'text-white/55'}`}>{!next ? 'done' : missing === 0 ? 'can build now' : `${missing} thing${missing === 1 ? '' : 's'} missing`}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

// ---------------------------------------------------------------------------

export function AmmoView({ id }: { id: string }) {
  const c = useDetails()
  usePrefs((s) => s.priceSource) // acquireCost reads this preference when rendering the rows.
  const traderFacts = { levels: c.traderLevels, completedTaskIds: c.completed }
  const rounds = useMemo(
    () =>
      Object.values(c.items ?? {})
        .filter((it) => it.ammo?.caliber === id)
        .sort((a, b) => (b.ammo!.penetrationPower - a.ammo!.penetrationPower) || shotDamage(b.ammo!) - shotDamage(a.ammo!)),
    [c.items, id],
  )
  return (
    <>
      <Heading>{caliberLabel(id)} rounds</Heading>
      <table className="mt-1.5 w-full text-[11px] tabular-nums">
        <thead className="text-white/45">
          <tr>
            <th className="text-left font-normal">Round</th>
            <th className="font-normal" title="Damage">Dmg</th>
            <th className="font-normal" title="Penetration">Pen</th>
            <th className="font-normal" title="Armour damage">Arm</th>
            <th className="font-normal" title="Armour class it handles well (rule of thumb)">Cls</th>
            <th className="text-right font-normal">Price</th>
          </tr>
        </thead>
        <tbody>
          {rounds.map((it) => {
            const a = it.ammo!
            const price = acquireCost(it, traderFacts, c.fleaRules)
            return (
              <tr key={it.id} className="hover:bg-white/5">
                <td className="max-w-[9rem] truncate">
                  <button type="button" onClick={() => c.open({ kind: 'item', id: it.id })} className="hover:text-white hover:underline">
                    {it.shortName}
                  </button>
                </td>
                <td className="text-center">{a.projectileCount > 1 ? `${a.damage}×${a.projectileCount}` : a.damage}</td>
                <td className="text-center">{a.penetrationPower}</td>
                <td className="text-center">{a.armorDamage}%</td>
                <td className="text-center">{bestArmorClass(a.penetrationPower)}</td>
                <td className="text-right text-white/70">{price ? formatRoubles(price) : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Muted>"Cls" estimates armour class from penetration. Prices use eligible flea averages and trader quotes. Current stock is unverified.</Muted>
    </>
  )
}

// ---------------------------------------------------------------------------

export function PathView({ which }: { which: 'kappa' | 'lightkeeper' }) {
  const c = useDetails()
  const profile = useProfile()
  const { targets, todo } = useMemo(() => {
    const tasks = c.data.tasks.filter((t) => isFactionEligible(t, profile.faction))
    const targets = tasks.filter((t) => (which === 'kappa' ? t.kappaRequired : t.lightkeeperRequired || t.trader.normalizedName === 'lightkeeper'))
    const closure = requiredClosure(
      targets.map((t) => t.id),
      c.data.tasksById,
      c.completed,
      (t) => isFactionEligible(t as Task, profile.faction),
    )
    return { targets, todo: topoOrder(closure, c.data.tasksById).map((id) => c.data.tasksById[id]).filter((t): t is Task => Boolean(t)) }
  }, [c.data, c.completed, profile.faction, which])
  const done = targets.filter((t) => c.completed.has(t.id)).length
  const available = todo.filter((t) => c.statuses[t.id] === 'available')
  const label = which === 'kappa' ? 'Kappa' : 'Lightkeeper'
  return (
    <>
      <Heading>{label} path</Heading>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-white/10">
        <div className="h-full bg-amber-300" style={{ width: `${targets.length ? (done / targets.length) * 100 : 0}%` }} />
      </div>
      <Muted>
        {done} of {targets.length} quests the data marks as needed for {label} are done; {todo.length} quests still to do on the way.
      </Muted>
      <Section title="You can do now" count={available.length} defaultOpen>
        <ul className="space-y-0.5">
          {available.map((t) => (
            <li key={t.id}>
              <QuestLink task={t} />
            </li>
          ))}
        </ul>
      </Section>
      <Section title="All still to do, in order" count={todo.length}>
        <ol className="space-y-0.5">
          {todo.slice(0, 120).map((t) => (
            <li key={t.id}>
              <QuestLink task={t} />
            </li>
          ))}
        </ol>
      </Section>
      {which === 'kappa' && <Muted>tarkov.dev marks only a few quests as Kappa-required; the in-game list may be longer.</Muted>}
    </>
  )
}

// ---------------------------------------------------------------------------

export function StoryView({ id }: { id: string | null }) {
  const c = useDetails()
  const qc = useQueryClient()
  const cached = qc.getQueriesData<StoryData>({ queryKey: ['story'] }).find(([, d]) => d)?.[1]
  const [load, setLoad] = useState(Boolean(cached))
  if (!cached && !load)
    return (
      <>
        <Heading>Story chapters</Heading>
        <Muted>The chapters come from the EFT Wiki (about 15 pages). They load once and are kept.</Muted>
        <div className="mt-1.5">
          <ActionButton onClick={() => setLoad(true)}>Load the story chapters</ActionButton>
        </div>
      </>
    )
  return <StoryLoaded id={id} open={(slug) => c.open({ kind: 'story', id: slug })} />
}

function StoryLoaded({ id, open }: { id: string | null; open: (slug: string) => void }) {
  const story = useStory()
  const c = useDetails()
  const progress = useStoryStore((s) => s.byMode[c.mode])
  const setDone = useStoryStore((s) => s.setDone)
  if (story.isPending) return <Muted>Loading the chapters from the wiki…</Muted>
  if (!story.data) return <Muted>The wiki could not be reached.</Muted>
  const chapter = id ? story.data.chapters.find((ch) => ch.slug === id) : null
  const short = (t: string) => t.replace(/\s*\(story chapter\)/i, '')
  if (!chapter)
    return (
      <>
        <Heading>Story chapters</Heading>
        <ul className="mt-1.5 space-y-0.5">
          {story.data.chapters.map((ch) => {
            const done = Object.keys(progress?.[ch.slug]?.done ?? {}).length
            const total = ch.objectives.filter((o) => !o.optional).length
            return (
              <li key={ch.slug}>
                <button type="button" onClick={() => open(ch.slug)} className="flex w-full items-center gap-2 text-left hover:text-white">
                  {ch.icon && <img src={ch.icon} alt="" className="h-5 w-5 object-contain" />}
                  <span className="min-w-0 flex-1 truncate">{short(ch.title)}</span>
                  <span className="text-[11px] tabular-nums text-white/50">
                    {Math.min(done, total)}/{total}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </>
    )
  const done = progress?.[chapter.slug]?.done ?? {}
  return (
    <>
      <Heading>{short(chapter.title)}</Heading>
      {chapter.description && <p className="mt-0.5 text-xs italic text-white/55">{chapter.description}</p>}
      <ul className="mt-1.5 space-y-0.5">
        {chapter.objectives.map((o) => (
          <li key={o.key} style={{ paddingLeft: o.depth * 10 }}>
            {o.branch && o === chapter.objectives.find((x) => x.branch === o.branch) && <div className="mt-1 text-[10px] uppercase tracking-wide text-white/45">{o.branch}</div>}
            <label className={`flex cursor-pointer items-start gap-1.5 text-xs ${o.optional ? 'text-white/55' : 'text-white/85'}`}>
              <input type="checkbox" checked={Boolean(done[o.key])} onChange={(e) => setDone(c.mode, chapter.slug, o.key, e.target.checked)} className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--color-accent)]" />
              <span>
                {o.text}
                {o.optional ? ' (optional)' : ''}
                {o.wait ? ` · wait ${o.wait.minH === o.wait.maxH ? o.wait.minH : `${o.wait.minH}–${o.wait.maxH}`} h` : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex gap-1.5">
        <ActionButton onClick={() => open('')}>All chapters</ActionButton>
        <ActionButton onClick={() => void window.desktop?.openExternal(chapter.pageUrl)}>
          Wiki <ExternalLink className="h-3 w-3" />
        </ActionButton>
      </div>
      <Muted>Ticks are the same as on the Story tab. Wait timers start from the Story tab.</Muted>
    </>
  )
}

// ---------------------------------------------------------------------------

export function HelpView() {
  return (
    <>
      <Heading>What the search bar can do</Heading>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs text-white/80">
        <li>Type a map, item, key, quest, trader, boss, extract or hideout station. "kappa", "lightkeeper", "traders", "hideout", "story", "settings" and "help" open those pages. With the box empty: buttons for every map and page, the Goons' last map, your starred and recent picks.</li>
        <li>Cards: quests (keys, items, what comes before and after, wiki pictures, Mark done), items (prices, flea after fee, 7-day chart, what needs it, where it lies, copy the name), keys (locks on the map, worth it?), traders (restock, loyalty, quests), bosses (spawn spots per map), hideout (what you can build now), ammo (every round of a calibre).</li>
        <li>"Pin beside" or the panel button keeps up to 3 cards next to the search.</li>
        <li>Every box (a card, the map, each side panel) moves on its own: drag its move bar on top. Drag the corner bottom right to resize it. New boxes open on the side of the bar with room. They stay where you put them; Settings → "Put boxes back next to the glass" resets them.</li>
        <li>Maps: the list on the right has quests, extracts, bosses, locked doors, loot and layers. Click anything to zoom there. Drag the corner to resize the map.</li>
        <li>Layers: bosses (exact spawn points), sniper scavs, PMC and scav spawns, locked doors with their keys, containers, valuable loose loot, loot you still need, hazards.</li>
        <li>Double-click a quest spot when you have done it. The ruler measures distances in metres.</li>
        <li>The camera next to the glass: drag a box around stash or container slots. "Item scan" shows what was found (green = keep, red = spare; drag the bottom edge of the picture to make it bigger); "Values" lists the spare items priciest first with a "Do not sell" list at the bottom, and its "Keep back" checkboxes choose what counts as keep (quests, Collector, hideout, keys, ammo, meds, gear, starred items…). Close either one on its own. "Manual tuning" on the picture opens it full screen (zoom with Ctrl + mouse wheel): move, resize, draw or delete boxes and pick the right item. Every fix is remembered, so the next scans get it right by themselves; "All correct" remembers a whole snip at once.</li>
        <li>The pills next to the glass: time left in your raid (from the game log), Tarkov time (left and right side), your scav cooldown.</li>
        <li>Take an in-game screenshot (Print Screen) in a raid: an arrow shows where you were, and the quest and extract lists show how far each is (straight line), nearest first.</li>
        <li>The Quests list shows what to bring for the ticked quests; the Locks list filters keys you have or keys your quests need.</li>
        <li>Drag the glass anywhere. Hotkeys (set them in the app's Settings → Desktop app): show/hide, open the search box, lock (clicks go through).</li>
        <li>Starred things and your last searches show when the search box is empty.</li>
      </ul>
    </>
  )
}

export function CheckRow({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1">
      {on && <Check className="h-3 w-3 text-green-400" />}
      {children}
    </span>
  )
}

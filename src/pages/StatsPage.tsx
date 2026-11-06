import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, ExternalLink, Info, RefreshCw } from 'lucide-react'
import { useGameData, useItems } from '../api/hooks'
import { SegmentButton } from '../components/SegmentButton'
import { isDesktop } from '../desktop/useDesktop'
import { formatDateTime, formatNumber, formatRoubles } from '../lib/format'
import { computeLogStats, formatMinutes, type LogStats } from '../lib/logStats'
import { useProgressStore } from '../store/progress'

type Range = 'all' | '30' | '7'
const DAY = 24 * 3_600_000

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface-2 px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-dim">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums text-ink">{value}</div>
      {hint && <div className="text-xs text-ink-muted">{hint}</div>}
    </div>
  )
}

function Card({ title, children, note }: { title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="rounded-lg border border-line bg-surface-2 p-4">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">{title}</h2>
      {children}
      {note && <p className="mt-2 text-[11px] text-ink-dim">{note}</p>}
    </section>
  )
}

/** Raids per day: one series, thin bars on a baseline, a tooltip per bar. */
function PerDayChart({ days }: { days: LogStats['perDay'] }) {
  const W = 600
  const H = 140
  const pad = { l: 24, r: 4, t: 8, b: 20 }
  const max = Math.max(1, ...days.map((d) => d.raids))
  const step = (W - pad.l - pad.r) / days.length
  const bw = Math.max(2, step - 2)
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Raids per day">
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--color-line)" />
      <text x={pad.l - 4} y={y(max) + 4} textAnchor="end" fontSize={10} fill="var(--color-ink-dim)">{max}</text>
      <text x={pad.l - 4} y={H - pad.b} textAnchor="end" fontSize={10} fill="var(--color-ink-dim)">0</text>
      {days.map((d, i) => {
        const x = pad.l + i * step + 1
        const h = H - pad.b - y(d.raids)
        const label = new Date(d.date).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
        return (
          <g key={d.day}>
            {/* Hit target: the whole column, bigger than the bar. */}
            <rect x={x - 1} y={pad.t} width={step} height={H - pad.t - pad.b} fill="transparent">
              <title>{`${label}: ${d.raids} raid${d.raids === 1 ? '' : 's'}`}</title>
            </rect>
            {d.raids > 0 && <path d={`M${x},${H - pad.b} v${-(h - 3)} q0,-3 3,-3 h${bw - 6} q3,0 3,3 v${h - 3} z`} fill="var(--color-accent)" pointerEvents="none" />}
            {(i % 7 === 0 || i === days.length - 1) && (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" fontSize={10} fill="var(--color-ink-dim)">{label}</text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

/** Flea rating over time: one line, a dot per change with its value on hover. */
function RatingChart({ points }: { points: LogStats['rating'] }) {
  if (points.length < 2) return <p className="text-sm text-ink-muted">{points.length ? `Rating ${points[0].rating.toFixed(2)}` : 'No rating changes logged.'}</p>
  const W = 600
  const H = 120
  const pad = { l: 34, r: 8, t: 8, b: 18 }
  const t0 = points[0].at
  const t1 = points[points.length - 1].at
  const lo = Math.min(...points.map((p) => p.rating))
  const hi = Math.max(...points.map((p) => p.rating))
  const span = hi - lo || 1
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r)
  const y = (v: number) => pad.t + (1 - (v - lo) / span) * (H - pad.t - pad.b)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Flea rating over time">
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--color-line)" />
      <text x={pad.l - 4} y={y(hi) + 4} textAnchor="end" fontSize={10} fill="var(--color-ink-dim)">{hi.toFixed(2)}</text>
      <text x={pad.l - 4} y={y(lo) + 4} textAnchor="end" fontSize={10} fill="var(--color-ink-dim)">{lo.toFixed(2)}</text>
      <polyline points={points.map((p) => `${x(p.at)},${y(p.rating)}`).join(' ')} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={x(p.at)} cy={y(p.rating)} r={6} fill="transparent">
          <title>{`${formatDateTime(p.at)}: ${p.rating.toFixed(2)}`}</title>
        </circle>
      ))}
      <text x={pad.l} y={H - 4} fontSize={10} fill="var(--color-ink-dim)">{new Date(t0).toLocaleDateString()}</text>
      <text x={W - pad.r} y={H - 4} textAnchor="end" fontSize={10} fill="var(--color-ink-dim)">{new Date(t1).toLocaleDateString()}</text>
    </svg>
  )
}

export function StatsPage() {
  const mode = useProgressStore((s) => s.gameMode)
  const [range, setRange] = useState<Range>('all')
  const gameData = useGameData()
  const items = useItems()
  const desktop = isDesktop()
  const query = useQuery({
    queryKey: ['logStats'],
    queryFn: () => window.desktop!.readLogStats(),
    enabled: desktop,
    // Logs only grow while you play; reading them on every return to the window was wasted work.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })

  // "since" is fixed per range choice; the clock only matters when the choice changes.
  const [since, setSince] = useState<number | null>(null)
  const pickRange = (r: Range) => {
    setRange(r)
    setSince(r === 'all' ? null : Date.now() - Number(r) * DAY)
  }
  const [includeOld, setIncludeOld] = useState(false)
  const resetAt = query.data?.resetAtByMode?.[mode] ?? null
  const stats = useMemo(() => (query.data ? computeLogStats(query.data, mode, since, 30, Date.now(), includeOld) : null), [query.data, mode, since, includeOld])
  // The logs name maps three ways: location ("bigmap"), display name, or map file ("maps/factory_day_preset.bundle").
  const mapName = (loc: string) =>
    gameData.data?.maps.find((m) => [m.nameId, m.name, m.scenePath ?? ''].some((n) => n && n.toLowerCase() === loc.toLowerCase()))?.name ?? loc.replace(/^maps\//, '').replace(/(_preset)?\.bundle$/, '')
  // Same map under different names counts once.
  const byMap = useMemo(() => {
    const m = new Map<string, { location: string; raids: number; minutes: number }>()
    for (const x of stats?.byMap ?? []) {
      const name = mapName(x.location)
      const cur = m.get(name) ?? { location: name, raids: 0, minutes: 0 }
      cur.raids += x.raids
      cur.minutes += x.minutes
      m.set(name, cur)
    }
    return [...m.values()].sort((a, b) => b.raids - a.raids)
    // mapName only depends on the map list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats, gameData.data])
  const itemName = (id: string) => items.data?.items[id]?.name ?? `Item …${id.slice(-6)}`
  const itemIcon = (id: string) => items.data?.items[id]?.iconLink ?? null
  const profileUrl = query.data?.accountId ? `https://tarkov.dev/players/${mode === 'pve' ? 'pve' : 'regular'}/${query.data.accountId}` : null

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">My stats</h1>
          <p className="text-sm text-ink-muted">
            From your own game log files on this PC ({mode === 'pve' ? 'PvE' : 'PvP'}){stats?.first ? `, ${new Date(stats.first).toLocaleDateString()} – ${new Date(stats.last ?? stats.first).toLocaleDateString()}` : ''}.
            {resetAt && !includeOld && <> Counting since your profile reset on <b className="text-ink">{new Date(resetAt).toLocaleDateString()}</b>; older logs belong to your previous profile.</>}
          </p>
        </div>
        {desktop && (
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded border border-line bg-surface-2 p-0.5">
              <SegmentButton label="All logs" active={range === 'all'} onClick={() => pickRange('all')} />
              <SegmentButton label="30 days" active={range === '30'} onClick={() => pickRange('30')} />
              <SegmentButton label="7 days" active={range === '7'} onClick={() => pickRange('7')} />
            </div>
            {resetAt && (
              <label className="flex items-center gap-1.5 text-xs text-ink-muted" title="Also count logs from before your last profile reset">
                <input type="checkbox" checked={includeOld} onChange={(e) => setIncludeOld(e.target.checked)} /> Include before reset
              </label>
            )}
            <button type="button" onClick={() => void query.refetch()} className="btn !py-1" title="Read the logs again">
              <RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} />
            </button>
          </div>
        )}
      </div>

      {!desktop ? (
        <p className="mt-4 rounded-lg border border-line bg-surface-2 p-4 text-sm text-ink-muted">Stats come from the game's log files, so they are only available in the desktop app.</p>
      ) : query.isPending ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-ink-muted"><RefreshCw className="h-4 w-4 animate-spin text-accent" /> Reading your game logs…</p>
      ) : query.isError || !stats ? (
        <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 p-4 text-sm text-ink">Could not read the logs: {query.error instanceof Error ? query.error.message : 'unknown error'}. Check the logs folder in Settings.</p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile label="Raids in the logs" value={formatNumber(stats.raids.length)} hint={stats.raids.length ? `${(stats.raids.length / Math.max(1, stats.perDay.filter((d) => d.raids > 0).length)).toFixed(1)} per day played (last 30 days)` : undefined} />
            <Tile label="Time in raid" value={formatMinutes(stats.raidMinutes)} hint={stats.raids.some((r) => r.minutes !== null) ? `avg ${formatMinutes(stats.raidMinutes / Math.max(1, stats.raids.filter((r) => r.minutes !== null).length))} per raid` : undefined} />
            <Tile label="Game open" value={formatMinutes(stats.playMinutes)} hint={`${stats.sessions} launches, PvP and PvE together`} />
            <Tile label="Quests handed in" value={formatNumber(stats.questsFinished)} hint={`${stats.questsStarted} started · ${stats.questsFailed} failed`} />
            <Tile label="Flea income" value={formatRoubles(stats.income.RUB)} hint={[stats.income.USD ? `+ $${formatNumber(stats.income.USD)}` : '', stats.income.EUR ? `+ €${formatNumber(stats.income.EUR)}` : ''].filter(Boolean).join(' ') || undefined} />
            <Tile label="Flea sales" value={formatNumber(stats.fleaSales)} hint={`${formatNumber(stats.fleaItems)} items · ${stats.fleaExpired} offers expired`} />
            <Tile label="Flea rating" value={stats.rating.length ? stats.rating[stats.rating.length - 1].rating.toFixed(2) : '–'} hint={stats.rating.length ? `latest of ${stats.rating.length} changes` : 'no change logged'} />
            <Tile label="Maps played" value={formatNumber(byMap.length)} hint={byMap[0] ? `most: ${byMap[0].location}` : undefined} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Raids per day (last 30 days)">
              <PerDayChart days={stats.perDay} />
            </Card>
            <Card title="Raids by map" note="A raid counts when a map is loaded and started. Its length needs the game's raid-over notice, which the game does not write for every raid, so some raids have no length.">
              {byMap.length === 0 ? (
                <p className="text-sm text-ink-muted">No raids in this period.</p>
              ) : (
                <ul className="space-y-1.5 text-sm">
                  {byMap.map((m) => (
                    <li key={m.location} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2" title={`${m.location}: ${m.raids} raids, ${formatMinutes(m.minutes)}`}>
                      <span className="truncate text-ink">{m.location}</span>
                      <span className="h-2.5 overflow-hidden rounded-r bg-surface-3"><span className="block h-full rounded-r bg-accent" style={{ width: `${(m.raids / byMap[0].raids) * 100}%` }} /></span>
                      <span className="tabular-nums text-ink-muted">{m.raids} · {formatMinutes(m.minutes)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Best sellers on the flea market" note="Ranked by roubles received (what the buyers paid, from the sale messages).">
              {stats.topSold.length === 0 ? (
                <p className="text-sm text-ink-muted">No flea sales in this period.</p>
              ) : (
                <table className="w-full text-sm">
                  <tbody className="divide-y divide-line/60">
                    {stats.topSold.map((s) => (
                      <tr key={s.itemId}>
                        <td className="py-1 pr-2">
                          <span className="flex items-center gap-2">
                            {itemIcon(s.itemId) ? <img src={itemIcon(s.itemId) as string} alt="" className="h-7 w-7 object-contain" loading="lazy" /> : <span className="h-7 w-7" />}
                            <span className="truncate">{itemName(s.itemId)}</span>
                          </span>
                        </td>
                        <td className="py-1 text-right tabular-nums text-ink-muted">{s.count}×</td>
                        <td className="py-1 pl-3 text-right tabular-nums">{s.currency === 'RUB' || !s.currency ? formatRoubles(s.income) : `${s.currency === 'USD' ? '$' : '€'}${formatNumber(s.income)}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title="Flea rating">
              <RatingChart points={stats.rating} />
            </Card>
          </div>

          <section className="rounded-lg border border-line bg-surface-2 p-4">
            <div className="flex flex-wrap items-start gap-3">
              <BarChart3 className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div className="min-w-0 flex-1 text-sm">
                <h2 className="font-semibold text-ink">Kills, deaths, survival rate and K/D</h2>
                <p className="mt-1 text-ink-muted">
                  The game does not write these to its log files, so the app cannot count them. They are on your public profile on tarkov.dev, which reads them from the game with a browser check that only works on its own website, so the app opens it in your browser instead of showing it here.
                </p>
              </div>
              {profileUrl ? (
                <button type="button" onClick={() => void window.desktop?.openExternal(profileUrl)} className="btn shrink-0">
                  Open my tarkov.dev profile <ExternalLink className="h-3.5 w-3.5" />
                </button>
              ) : (
                <span className="text-xs text-ink-dim">Start the game once so the app can read your account id from the logs.</span>
              )}
            </div>
          </section>

          <p className="flex items-start gap-1.5 text-[11px] text-ink-dim">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Everything above is counted on this PC from the text logs the game writes for itself (read-only). Logs only go back as far as the game keeps them, and nothing is sent anywhere.
          </p>
        </div>
      )}
    </div>
  )
}

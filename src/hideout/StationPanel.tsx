import { useState } from 'react'
import { Check, ChevronRight, Clock, Hammer, Lock, MapPin, Minus, Plus, Timer, X } from 'lucide-react'
import type { HideoutLevel, Item } from '../api/types'
import { formatDuration } from '../lib/economy'
import { formatNumber } from '../lib/format'
import { bonusText, type StationInfo } from '../lib/hideoutState'
import { CURRENCY_ITEM_IDS } from '../lib/needs'
import { useHideoutTimers, type BuildTimer } from '../store/hideoutTimers'
import type { BunkerProps } from './BunkerView'
import { Countdown, TimerBar } from './Countdown'
import { lookLabel, type Look, type Names } from './look'
import type { SpotSource } from './useStationSpots'

interface PanelProps extends BunkerProps {
  info: StationInfo | null
  look: Look | null
  timer: BuildTimer | undefined
  names: Names
  ready: StationInfo[]
  /** Where the station's spot on the map came from. */
  spotSource?: SpotSource
  onArrange?: () => void
  onPick: (stationId: string) => void
  onClose: () => void
}

const LEGEND: { look: Look; text: string }[] = [
  { look: 'ready', text: 'Tracked requirements met: recorded station levels, known trader levels, and item counts are sufficient' },
  { look: 'items', text: 'Needs items: your Item Collection counts are below the required amounts' },
  { look: 'review', text: 'Check item requirements: an amount or found-in-raid requirement cannot be verified' },
  { look: 'locked', text: 'Locked: another station or a trader level is missing' },
  { look: 'building', text: 'Building: a build timer you started is running' },
  { look: 'max', text: 'Fully built' },
]

export function StationPanel(props: PanelProps) {
  const { info, look } = props
  if (!info || !look) return <Overview {...props} />
  return <Details {...props} info={info} look={look} />
}

function Overview({ ready, onPick }: PanelProps) {
  return (
    <aside className="tc-panel">
      <h2 className="text-sm font-semibold">Your hideout</h2>
      <p className="mt-1 text-xs text-ink-muted">Click a station to see what its next level needs, set its level and start a build timer. Hover one to see what it depends on.</p>
      <ul className="mt-3 space-y-1.5 text-xs">
        {LEGEND.map((l) => (
          <li key={l.look} className={`tc-st-${l.look} flex gap-2`}>
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: 'var(--st)' }} />
            <span className="text-ink-muted">{l.text}</span>
          </li>
        ))}
      </ul>
      {ready.length > 0 && (
        <>
          <h3 className="mt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-muted">Tracked requirements met</h3>
          <ul className="mt-1.5 space-y-1">
            {ready.map((i) => (
              <li key={i.station.id}>
                <button type="button" onClick={() => onPick(i.station.id)} className="tc-row w-full">
                  {i.station.imageLink && <img src={i.station.imageLink} alt="" className="h-6 w-6" />}
                  <span className="flex-1 text-left">{i.station.name} → level {i.next?.level}</span>
                  <ChevronRight className="h-3.5 w-3.5 text-ink-dim" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-4 text-[11px] text-ink-dim">The app cannot see your skills, so skill requirements are listed but never counted. Money is not tracked either.</p>
    </aside>
  )
}

function Details(props: PanelProps & { info: StationInfo; look: Look }) {
  const { info, look, names, onPick, onClose, setLevel, spotSource, onArrange } = props
  const { station, level, max, next } = info
  const setTo = (n: number) => setLevel(station.id, Math.max(0, Math.min(max, n)))
  const shown = next ?? station.levels.find((l) => l.level === level) ?? null
  const unlocks = info.unlocks.filter((u, i, all) => all.findIndex((x) => x.stationId === u.stationId && x.level === u.level) === i)

  return (
    <aside className="tc-panel" aria-label={`${station.name} details`}>
      <div className="flex items-start gap-3">
        <span className={`tc-hex is-static tc-st-${look} ${level > 0 ? 'is-built' : 'is-empty'}`}>
          <span className="tc-hex-ring" />
          <span className="tc-hex-core">{station.imageLink && <img src={station.imageLink} alt="" />}</span>
          <span className="tc-hex-num">{String(level).padStart(2, '0')}</span>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold leading-tight">{station.name}</h2>
          <p className={`tc-st-${look} mt-0.5 text-xs`} style={{ color: 'var(--st)' }}>
            {lookLabel(look, info, names)}
          </p>
        </div>
        <button type="button" onClick={onClose} className="rounded p-1 text-ink-dim hover:text-ink" aria-label="Close" title="Close (Esc)">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="flex items-center rounded border border-line bg-surface" role="group" aria-label="Your level">
          <button type="button" onClick={() => setTo(level - 1)} disabled={level <= 0} className="px-2 py-1 text-ink-muted hover:text-ink disabled:opacity-30" aria-label="One level lower">
            <Minus className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[4.5rem] text-center text-xs tabular-nums">
            Level <b className="text-ink">{level}</b> / {max}
          </span>
          <button type="button" onClick={() => setTo(level + 1)} disabled={level >= max} className="px-2 py-1 text-ink-muted hover:text-ink disabled:opacity-30" aria-label="One level higher">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
        <span className={`tc-pips tc-st-${look}`} aria-hidden>
          {Array.from({ length: max }, (_, i) => (
            <i key={i} className={i < level ? 'on' : i === level ? 'next' : ''} />
          ))}
        </span>
      </div>

      {spotSource && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] text-ink-dim">
          <MapPin className="mt-px h-3 w-3 shrink-0" />
          <span>
            {spotSource === 'shot' ? 'Spot on the map read from in-game overview screenshots.' : spotSource === 'moved' ? 'Spot on the map moved by you.' : 'Spot on the map is a best guess (not built in the screenshots the map was drawn from).'}
            {spotSource !== 'shot' && onArrange && (
              <>
                {' '}
                <button type="button" onClick={onArrange} className="text-accent underline underline-offset-2">
                  Move stations
                </button>
              </>
            )}
          </span>
        </p>
      )}

      {shown?.description && (
        <p className="mt-3 border-l-2 border-accent-dim pl-2 text-xs italic text-ink-muted">
          {next ? `Level ${next.level}: ` : ''}
          {shown.description}
        </p>
      )}

      {next ? (
        <section className="mt-4">
          <h3 className="tc-panel-h">Level {next.level} needs</h3>
          <NextLevel {...props} level={next} />
          <BuildControls {...props} level={next} onBuilt={() => setTo(next.level)} />
        </section>
      ) : (
        <p className="mt-4 rounded border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-accent">Fully built. Nothing left to do here.</p>
      )}

      {shown && shown.bonuses.length > 0 && (
        <section className="mt-4">
          <h3 className="tc-panel-h">{next ? `Level ${next.level} gives` : 'Gives'}</h3>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
            {shown.bonuses.map((b, i) => (
              <li key={i}>• {bonusText(b)}</li>
            ))}
          </ul>
        </section>
      )}

      {unlocks.length > 0 && (
        <section className="mt-4">
          <h3 className="tc-panel-h">Opens up</h3>
          <ul className="mt-1 space-y-1">
            {unlocks.map((u) => (
              <li key={`${u.stationId}-${u.level}`}>
                <button type="button" onClick={() => onPick(u.stationId)} className="tc-row w-full text-left">
                  <span className="flex-1">
                    {names.station(u.stationId)} {u.level}
                    <span className="text-ink-dim"> · needs {station.name} {u.needs}</span>
                  </span>
                  {level >= u.needs ? <Check className="h-3.5 w-3.5 text-success" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-dim" />}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {max > 1 && (
        <details className="mt-4">
          <summary className="tc-panel-h cursor-pointer select-none">Every level</summary>
          <ol className="tc-timeline mt-2">
            {station.levels.map((l) => (
              <li key={l.id} className={l.level <= level ? 'is-done' : l.level === level + 1 ? 'is-next' : ''}>
                <div className="flex items-baseline gap-2 text-xs">
                  <b>Level {l.level}</b>
                  <span className="text-ink-dim">
                    {formatDuration(l.constructionTime)} · {l.itemRequirements.filter((r) => !CURRENCY_ITEM_IDS.has(r.itemId)).length} items
                  </span>
                  {l.level <= level && <Check className="h-3 w-3 text-success" />}
                </div>
                {l.bonuses.length > 0 && <p className="text-[11px] text-ink-dim">{l.bonuses.map(bonusText).join(' · ')}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}

    </aside>
  )
}

function NextLevel({ level, items, collected, setCollected, infos, names, traderLevel, onPick }: PanelProps & { level: HideoutLevel }) {
  const goods = level.itemRequirements.filter((r) => !CURRENCY_ITEM_IDS.has(r.itemId))
  const money = level.itemRequirements.filter((r) => CURRENCY_ITEM_IDS.has(r.itemId))
  return (
    <div className="mt-1.5 space-y-2 text-xs">
      {goods.length > 0 && (
        <ul className="space-y-1">
          {goods.map((r) => (
            <ItemRow key={r.itemId} item={items?.[r.itemId]} need={r.count} fir={r.foundInRaid} have={collected[r.itemId] ?? 0} onSet={(n) => setCollected(r.itemId, n)} />
          ))}
        </ul>
      )}
      {money.map((r) => {
        const cash = items?.[r.itemId]
        return (
          <div key={r.itemId} className="tc-row">
            {cash?.iconLink ? <img src={cash.iconLink} alt="" className="h-7 w-7 object-contain" /> : <span className="h-7 w-7" />}
            <span className="flex-1">
              {r.count === null ? 'Unknown amount of' : formatNumber(r.count)} {cash?.shortName ?? 'money'}
            </span>
            <span className="text-[10px] text-ink-dim">money is not tracked</span>
          </div>
        )
      })}
      {level.stationLevelRequirements.map((r) => {
        const have = infos.get(r.stationId)?.level ?? 0
        const met = have >= r.level
        return (
          <button key={r.stationId} type="button" onClick={() => onPick(r.stationId)} className="tc-row w-full text-left">
            {met ? <Check className="h-3.5 w-3.5 text-success" /> : <Lock className="h-3.5 w-3.5 text-danger" />}
            <span className="flex-1">
              {names.station(r.stationId)} level {r.level}
            </span>
            <span className={`tabular-nums ${met ? 'text-success' : 'text-danger'}`}>you: {have}</span>
          </button>
        )
      })}
      {level.traderRequirements.map((r) => {
        const have = traderLevel?.[r.traderId]
        const met = have === undefined ? null : have >= r.level
        return (
          <div key={r.traderId} className="tc-row">
            {met === null ? <span className="w-3.5 text-center text-ink-dim">?</span> : met ? <Check className="h-3.5 w-3.5 text-success" /> : <Lock className="h-3.5 w-3.5 text-danger" />}
            <span className="flex-1">
              {names.trader(r.traderId)} loyalty level {r.level}
            </span>
            {have !== undefined && <span className={`tabular-nums ${met ? 'text-success' : 'text-danger'}`}>you: LL{have}</span>}
          </div>
        )
      })}
      {level.skillRequirements.map((r) => (
        <div key={r.skill} className="tc-row">
          <span className="w-3.5 text-center text-ink-dim">?</span>
          <span className="flex-1">
            {r.skill} skill level {r.level}
          </span>
          <span className="text-[10px] text-ink-dim">not visible to the app</span>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-ink-muted">
        <Clock className="h-3.5 w-3.5" /> Build time <b className="font-semibold text-ink">{formatDuration(level.constructionTime)}</b>
        <span className="text-[11px] text-ink-dim">(less with Hideout Management)</span>
      </div>
    </div>
  )
}

function ItemRow({ item, need, fir, have, onSet }: { item: Item | undefined; need: number | null; fir: boolean | null; have: number; onSet: (n: number) => void }) {
  const done = need !== null && have >= need && (need === 0 || fir === false)
  return (
    <li className={`tc-row ${done ? 'is-done' : ''}`}>
      {item?.iconLink ? <img src={item.iconLink} alt="" className="h-7 w-7 object-contain" loading="lazy" /> : <span className="h-7 w-7" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item?.name ?? '…'}</span>
        {fir !== false && (
          <span className="text-[10px] text-ink-dim">
            {fir === true ? 'Found in raid required · check your items' : 'Found-in-raid requirement unknown'}
          </span>
        )}
      </span>
      <span className="flex items-center gap-0.5" title="Your count in Item Collection">
        <button type="button" onClick={() => onSet(Math.max(0, have - 1))} disabled={have <= 0} className="rounded p-0.5 text-ink-dim hover:text-ink disabled:opacity-30" aria-label={`One ${item?.shortName ?? 'item'} less`}>
          <Minus className="h-3 w-3" />
        </button>
        <span className={`min-w-[2.6rem] text-center tabular-nums ${done ? 'text-success' : 'text-ink'}`}>
          {need === null ? have : Math.min(have, need)}/{need ?? '?'}
        </span>
        <button type="button" onClick={() => onSet(have + 1)} className="rounded p-0.5 text-ink-dim hover:text-ink" aria-label={`One ${item?.shortName ?? 'item'} more`}>
          <Plus className="h-3 w-3" />
        </button>
      </span>
    </li>
  )
}

function BuildControls({ info, look, level, timer, gameMode, onBuilt }: PanelProps & { info: StationInfo; level: HideoutLevel; onBuilt: () => void }) {
  const start = useHideoutTimers((s) => s.start)
  const clear = useHideoutTimers((s) => s.clear)
  const [h, setH] = useState('')
  const [m, setM] = useState('')
  const label = `${info.station.name} level ${level.level}`
  const begin = (seconds: number) => {
    const now = Date.now()
    start(gameMode, info.station.id, { level: level.level, startedAt: now, endsAt: now + seconds * 1000, label })
  }
  const typed = (Number(h) || 0) * 3600 + (Number(m) || 0) * 60

  if (timer) {
    const finished = look === 'done'
    return (
      <div className="mt-3 rounded-lg border border-line bg-surface p-2.5">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 font-medium">
            <Hammer className="h-3.5 w-3.5 text-info" /> Building level {timer.level}
          </span>
          <span className="tabular-nums text-ink-muted">
            <Countdown endsAt={timer.endsAt} /> left
          </span>
        </div>
        <div className="mt-2">
          <TimerBar startedAt={timer.startedAt} endsAt={timer.endsAt} />
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          <button type="button" onClick={onBuilt} className={`btn !px-2 !py-1 !text-xs ${finished ? '!border-success !text-success' : ''}`}>
            <Check className="h-3.5 w-3.5" /> Mark level {level.level} built
          </button>
          <button type="button" onClick={() => clear(gameMode, info.station.id)} className="btn !px-2 !py-1 !text-xs">
            Stop timer
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={onBuilt} className={`btn !px-2 !py-1 !text-xs ${info.state === 'ready' ? '!border-success !text-success' : ''}`}>
          <Check className="h-3.5 w-3.5" /> Mark level {level.level} built
        </button>
        {level.constructionTime > 0 && (
          <button type="button" onClick={() => begin(level.constructionTime)} className="btn !px-2 !py-1 !text-xs" title="Counts down the full build time; you get a notification when it ends">
            <Timer className="h-3.5 w-3.5" /> Start build timer
          </button>
        )}
      </div>
      {level.constructionTime > 0 && (
        <details className="text-xs text-ink-muted">
          <summary className="cursor-pointer select-none">Already building in the game?</summary>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span>Time left the game shows:</span>
            <input value={h} onChange={(e) => setH(e.target.value.replace(/\D/g, '').slice(0, 3))} inputMode="numeric" placeholder="0" aria-label="Hours left" className="w-11 rounded border border-line bg-surface px-1.5 py-0.5 text-ink" />
            h
            <input value={m} onChange={(e) => setM(e.target.value.replace(/\D/g, '').slice(0, 2))} inputMode="numeric" placeholder="0" aria-label="Minutes left" className="w-11 rounded border border-line bg-surface px-1.5 py-0.5 text-ink" />
            m
            <button type="button" disabled={typed <= 0} onClick={() => begin(typed)} className="btn !px-2 !py-0.5 !text-xs">
              Start
            </button>
          </div>
        </details>
      )}
    </div>
  )
}

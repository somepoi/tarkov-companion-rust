import { useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronRight, Copy, ExternalLink, GitBranch, KeyRound, Lock, Map as MapIcon, Minus, PanelRightOpen, Plus, Star, Unlock } from 'lucide-react'
import { usePriceHistory } from '../api/hooks'
import type { Item, Task } from '../api/types'
import { useKeyWiki } from '../api/wikiKey'
import { useWikiGuide, type GuideImage } from '../api/wikiGuide'
import { WikiImage } from '../components/WikiImage'
import { bestArmorClass, caliberLabel, shotDamage } from '../lib/ammo'
import { fleaFee } from '../lib/economy'
import { formatNumber, formatRoubles } from '../lib/format'
import { keyVerdict } from '../lib/keyVerdict'
import { remainingFor } from '../lib/needs'
import { STATUS_LABEL } from '../lib/taskStatus'
import { ObjectiveFacts } from '../components/ObjectiveFacts'
import { isRequirementMet, lockReasons } from '../lib/progression'
import { requiredClosure } from '../quests/questGraph'
import { useInventoryStore } from '../store/inventory'
import { useMapOverlayStore } from '../store/mapOverlay'
import { useProgressStore } from '../store/progress'
import { useDetails } from './detailsContext'
import type { Ref } from './overlayPrefs'

/** A fold-out part of a card. Its content (and any download it needs) only exists once opened. */
export function Section({ title, count, defaultOpen = false, children }: { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-1.5 border-t border-white/10 pt-1">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-1 text-left text-[11px] uppercase tracking-wide text-white/55 hover:text-white">
        <ChevronRight className={`h-3 w-3 shrink-0 ${open ? 'rotate-90' : ''}`} />
        {title}
        {count != null && <span className="text-white/35">({count})</span>}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  )
}

/** An item name that opens its details beside the card. */
export function ItemLink({ id, children }: { id: string; children?: ReactNode }) {
  const c = useDetails()
  const it = c.items?.[id]
  if (!it) return <span className="text-white/70">{children ?? 'Unknown item'}</span>
  return (
    <button type="button" onClick={() => c.open({ kind: 'item', id })} title="Details beside this card" className="inline-flex min-w-0 items-center gap-1.5 text-left hover:text-white hover:underline">
      {it.iconLink && <img src={it.iconLink} alt="" loading="lazy" className="h-5 w-5 shrink-0 object-contain" />}
      <span className="min-w-0 truncate">{it.name}</span>
      {children}
    </button>
  )
}

export function QuestLink({ task, note }: { task: Task; note?: string }) {
  const c = useDetails()
  const done = c.completed.has(task.id)
  const status = c.statuses[task.id]
  return (
    <button type="button" onClick={() => c.open({ kind: 'quest', id: task.id })} title="Details beside this card" className="inline-flex min-w-0 max-w-full items-center gap-1 text-left hover:text-white hover:underline">
      {done ? <Check className="h-3 w-3 shrink-0 text-green-400" /> : <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status === 'available' ? 'bg-green-400' : 'bg-white/40'}`} />}
      <span className={`min-w-0 truncate ${done ? 'text-white/55' : ''}`}>{task.name}</span>
      <span className="shrink-0 text-[11px] text-white/40">{note ?? task.trader.name}</span>
    </button>
  )
}

/** ☆ / ★: keeps something at the top of the empty search. */
export function StarButton({ r }: { r: Ref }) {
  const c = useDetails()
  const on = c.starred(r.kind, r.id)
  return (
    <button type="button" onClick={() => c.star(r)} title={on ? 'Remove the star' : 'Star it: shown first when the search is empty'} aria-label={on ? 'Unstar' : 'Star'} className={`shrink-0 p-0.5 ${on ? 'text-amber-300' : 'text-white/40 hover:text-white'}`}>
      <Star className={`h-3.5 w-3.5 ${on ? 'fill-amber-300' : ''}`} />
    </button>
  )
}

/** − n + for counts and levels. */
export function Stepper({ value, min = 0, max = 999, onChange, label }: { value: number; min?: number; max?: number; onChange: (v: number) => void; label: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-label={label}>
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} disabled={value <= min} aria-label={`${label}: one less`} className="rounded border border-white/20 p-0.5 hover:bg-white/10 disabled:opacity-30">
        <Minus className="h-3 w-3" />
      </button>
      <span className="min-w-[1.5rem] text-center tabular-nums">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} disabled={value >= max} aria-label={`${label}: one more`} className="rounded border border-white/20 p-0.5 hover:bg-white/10 disabled:opacity-30">
        <Plus className="h-3 w-3" />
      </button>
    </span>
  )
}

export function ActionButton({ onClick, children, title, active }: { onClick: () => void; children: ReactNode; title?: string; active?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title} className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${active ? 'border-green-400/50 bg-green-500/15 text-green-200 hover:bg-green-500/25' : 'border-white/20 bg-white/10 hover:bg-white/20'}`}>
      {children}
    </button>
  )
}

/** Wiki pictures as small tiles; a click shows one large beside the card. */
export function Pictures({ images, title }: { images: GuideImage[]; title: string }) {
  const c = useDetails()
  if (!images.length) return null
  return (
    <div className="grid grid-cols-3 gap-1">
      {images.slice(0, 12).map((img) => (
        <button key={img.full} type="button" onClick={() => c.open({ kind: 'picture', image: img, title })} title={img.caption || 'Show it larger'} className="overflow-hidden rounded bg-white/5 hover:ring-1 hover:ring-white/40">
          <WikiImage src={img.thumb} alt={img.caption} loading="lazy" className="h-16 w-full object-cover" />
        </button>
      ))}
    </div>
  )
}

export function WikiCredit({ url }: { url: string }) {
  return (
    <button type="button" onClick={() => void window.desktop?.openExternal(url)} className="mt-1 inline-flex items-center gap-1 text-[10px] text-white/40 hover:text-white">
      EFT Wiki (CC BY-SA) <ExternalLink className="h-2.5 w-2.5" />
    </button>
  )
}

function GuidePictures({ task }: { task: Task }) {
  const g = useWikiGuide(task.wikiLink)
  if (g.isPending) return <p className="text-xs text-white/55">Loading the wiki guide…</p>
  if (!g.data) return <p className="text-xs text-white/55">No wiki guide found for this quest.</p>
  return (
    <>
      <Pictures images={g.data.images} title={task.name} />
      {g.data.images.length === 0 && <p className="text-xs text-white/55">The wiki page has no pictures.</p>}
      {g.data.guideText.length > 0 && (
        <div className="mt-1.5 space-y-1 text-xs text-white/75">
          {g.data.guideText.slice(0, 8).map((t, i) => (
            <p key={i}>{t}</p>
          ))}
        </div>
      )}
      <WikiCredit url={g.data.pageUrl} />
    </>
  )
}

/** Hand-ins and things to place; "find" objectives repeat the hand-in, so they are left out. */
const ITEM_OBJECTIVES = new Set(['giveItem', 'plantItem', 'giveQuestItem', 'plantQuestItem'])

export function QuestDetails({ task }: { task: Task }) {
  const c = useDetails()
  const setDone = useProgressStore((s) => s.setTaskCompleted)
  const setActive = useProgressStore((s) => s.setTaskActiveFor)
  const addCompleted = useProgressStore((s) => s.addCompletedFor)
  const status = c.statuses[task.id] ?? 'locked'
  const done = c.completed.has(task.id)
  const keyIds = useMemo(() => [...new Set([...task.neededKeys.flatMap((k) => k.keyIds), ...task.objectives.flatMap((o) => o.requiredKeys.flat())])], [task])
  const itemRows = task.objectives.filter((o) => ITEM_OBJECTIVES.has(o.type) && (o.itemIds.length > 0 || o.questItem))
  const markers = task.objectives.filter((o) => o.markerItemId)
  const before = task.taskRequirements.map((r) => ({ task: c.data.tasksById[r.taskId], status: r.status })).filter((r): r is { task: Task; status: string[] } => Boolean(r.task))
  const unlocks = useMemo(() => c.data.tasks.filter((t) => t.taskRequirements.some((r) => r.taskId === task.id)), [c.data.tasks, task.id])
  const mapIds = [...new Set([task.map?.id, ...task.objectives.flatMap((o) => o.maps.map((m) => m.id))].filter((id): id is string => Boolean(id)))]
  const mapName = (id: string) => c.data.maps.find((m) => m.id === id)?.name ?? 'Map'
  const delay = task.availableDelay
  const ctx = c.progress
  const inferred = Boolean(ctx?.inferred.has(task.id))
  const active = Boolean(ctx?.active.has(task.id))
  const reasons = ctx && status === 'locked' ? lockReasons(task, ctx, (id) => c.data.tasksById[id]?.name ?? 'an earlier quest', c.traderName) : []
  const notDoneBefore = ctx ? [...requiredClosure([task.id], c.data.tasksById, ctx.completed)].filter((id) => id !== task.id) : []
  const level = ctx?.level ?? 0
  // Spots double-clicked as done on a map (per objective).
  const doneSpots = useMapOverlayStore((s) => s.doneSpots[c.mode])
  const spotsDone = (objectiveId: string) => (doneSpots ?? []).filter((k) => k.startsWith(`${objectiveId}:`)).length
  return (
    <>
      <div className="flex items-start gap-1">
        <div className="min-w-0 flex-1 font-medium leading-snug">{task.name}</div>
        <StarButton r={{ kind: 'quest', id: task.id, label: task.name }} />
        <OnMapBox checked={c.onMap.includes(task.id)} onChange={(on) => c.tickQuest(task, on)} />
      </div>
      <div className="text-xs text-white/60">
        {task.trader.name} · {task.map?.name ?? (mapIds.length ? mapIds.map(mapName).join(', ') : 'any map')} ·{' '}
        <span className={status === 'available' ? 'text-green-400' : status === 'completed' ? 'text-white/45' : 'text-amber-300'}>{STATUS_LABEL[status]}</span>
        {task.minPlayerLevel > 1 ? ` · level ${task.minPlayerLevel}` : ''}
        {task.experience ? ` · ${formatNumber(task.experience)} XP` : ''}
        {task.kappaRequired ? ' · Kappa' : ''}
        {task.lightkeeperRequired ? ' · Lightkeeper' : ''}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <ActionButton onClick={() => setDone(task.id, !done || inferred)} active={done && !inferred} title={inferred ? 'Done by deduction (a later quest is done or started). Click to tick it.' : done ? 'Ticked as done in the app. Click to untick.' : 'Tick it as done in the app (same as on the Quests tab)'}>
          <Check className="h-3 w-3" /> {inferred ? 'Done (deduced) · tick' : done ? 'Done' : 'Mark done'}
        </ActionButton>
        {!done && (
          <ActionButton onClick={() => setActive(c.mode, task.id, !active)} active={active} title="The game gave you this quest: it counts as open here, and everything before it as done">
            <Unlock className="h-3 w-3" /> {active ? 'I have it ✓' : 'I have this quest'}
          </ActionButton>
        )}
        {!done && notDoneBefore.length > 0 && (
          <ActionButton onClick={() => addCompleted(c.mode, notDoneBefore)} title={notDoneBefore.map((id) => c.data.tasksById[id]?.name).filter(Boolean).join('\n')}>
            <Check className="h-3 w-3" /> Mark the {notDoneBefore.length} before it done
          </ActionButton>
        )}
        <ActionButton onClick={() => c.open({ kind: 'questline', id: task.id })} title="Everything before and after this quest">
          <GitBranch className="h-3 w-3" /> Questline
        </ActionButton>
        {mapIds.slice(0, 3).map((id) => (
          <ActionButton
            key={id}
            onClick={() => {
              if (!c.onMap.includes(task.id)) c.tickQuest(task, true)
              c.openMap(id, { focus: task.id })
            }}
            title="Its spots on the map, zoomed in"
          >
            <MapIcon className="h-3 w-3" /> {mapName(id)}
          </ActionButton>
        ))}
      </div>
      {reasons.length > 0 && (
        <div className="mt-1.5 rounded border border-amber-300/30 bg-amber-300/10 px-2 py-1 text-xs">
          <div className="text-[10px] uppercase tracking-wide text-amber-200">Locked because</div>
          {reasons.map((r, i) => (
            <div key={i} className="text-white/80">• {r.text}</div>
          ))}
        </div>
      )}
      <ul className="mt-1.5 space-y-0.5 text-white/85">
        {task.objectives.map((o) => (
          <li key={o.id} className={`flex gap-1.5 ${o.optional ? 'text-white/50' : ''}`}>
            {spotsDone(o.id) > 0 ? <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-400" /> : <span className="text-white/40">•</span>}
            <span className="min-w-0">
              {o.description}
              {o.optional ? ' (optional)' : ''}
              {spotsDone(o.id) > 0 && <span className="text-[10px] text-green-300"> · {spotsDone(o.id)} spot{spotsDone(o.id) === 1 ? '' : 's'} done on the map</span>}
              {o.maps.length > 0 && <span className="text-[10px] text-white/40"> · {o.maps.map((m) => m.name).join(', ')}</span>}
              {o.requiredKeys.map((g, i) => (
                <span key={i} className="ml-1 inline-flex items-center gap-0.5 text-[10px] text-amber-200">
                  <KeyRound className="h-2.5 w-2.5" />
                  {g.map((id) => c.items?.[id]?.shortName ?? 'key').join(' or ')}
                </span>
              ))}
              {o.wearingIds.length > 0 && <span className="text-[10px] text-white/55"> · wear {o.wearingIds[0].map((id) => c.items?.[id]?.shortName ?? 'item').join(' + ')}{o.wearingIds.length > 1 ? ` (or ${o.wearingIds.length - 1} other)` : ''}</span>}
              <ObjectiveFacts objective={o} className="block text-[10px] text-white/60" warnClassName="block text-[10px] text-amber-300" />
            </span>
          </li>
        ))}
      </ul>
      {keyIds.length > 0 && (
        <Section title="Keys needed" count={keyIds.length} defaultOpen>
          <ul className="space-y-0.5">
            {keyIds.map((id) => (
              <li key={id} className="flex items-center gap-1.5">
                <ItemLink id={id} />
                <span className={`shrink-0 text-[10px] ${c.ownedKeyIds.has(id) ? 'text-green-300' : 'text-white/40'}`}>{c.ownedKeyIds.has(id) ? 'you have it' : 'not marked as owned'}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {(itemRows.length > 0 || markers.length > 0) && (
        <Section title="Items" count={itemRows.length + markers.length} defaultOpen>
          <ul className="space-y-0.5">
            {itemRows.map((o) => (
              <li key={o.id} className="flex items-center gap-1.5">
                <span className="shrink-0 tabular-nums text-white/55">{o.count ?? 1}×</span>
                {o.itemIds.length ? <ItemLink id={o.itemIds[0]} /> : <span>{o.questItem?.name}</span>}
                {o.foundInRaid && <span className="shrink-0 text-[10px] text-amber-300">FIR</span>}
                {o.itemIds.length > 1 && <span className="shrink-0 text-[10px] text-white/40">or {o.itemIds.length - 1} other{o.itemIds.length > 2 ? 's' : ''}</span>}
                <span className="shrink-0 text-[10px] text-white/40">{/plant/i.test(o.type) ? 'place' : 'hand in'}</span>
              </li>
            ))}
            {markers.map((o) => (
              <li key={`m${o.id}`} className="flex items-center gap-1.5">
                <span className="shrink-0 text-white/55">1×</span>
                <ItemLink id={o.markerItemId!} />
                <span className="shrink-0 text-[10px] text-white/40">to mark</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {(before.length > 0 || task.otherRequirements.length > 0 || task.minPlayerLevel > 1 || delay) && (
        <Section title="What it needs" count={before.length + task.traderRequirements.length + (task.minPlayerLevel > 1 ? 1 : 0)} defaultOpen={status === 'locked'}>
          <ul className="space-y-0.5">
            {task.minPlayerLevel > 1 && (
              <li className="flex items-center gap-1.5 text-xs">
                {level >= task.minPlayerLevel ? <Check className="h-3 w-3 text-green-400" /> : <Lock className="h-3 w-3 text-white/45" />}
                Level {task.minPlayerLevel} <span className="text-white/45">(you: {level || '?'})</span>
              </li>
            )}
            {before.map((r) => {
              const met = ctx ? isRequirementMet(r.status, r.task.id, ctx) : c.completed.has(r.task.id)
              return (
                <li key={r.task.id} className="flex items-center gap-1.5">
                  {met ? <Check className="h-3 w-3 shrink-0 text-green-400" /> : <Lock className="h-3 w-3 shrink-0 text-white/45" />}
                  <QuestLink task={r.task} note={ctx?.inferred.has(r.task.id) ? 'done by deduction' : r.status.includes('complete') && r.status.length === 1 ? undefined : `needs it ${r.status.join(' or ')}`} />
                </li>
              )
            })}
            {task.traderRequirements.map((r, i) => {
              const have = c.traderLevels[r.traderId] ?? 1
              return r.type === 'level' ? (
                <li key={`t${i}`} className="flex items-center gap-1.5 text-xs">
                  {have >= r.value ? <Check className="h-3 w-3 text-green-400" /> : <Lock className="h-3 w-3 text-white/45" />}
                  {c.traderName(r.traderId)} loyalty {r.value} <span className="text-white/45">(you: {have})</span>
                </li>
              ) : (
                <li key={`t${i}`} className="text-xs text-white/60">
                  ? {c.traderName(r.traderId)} reputation {r.compare} {r.value} <span className="text-white/40">(check in game)</span>
                </li>
              )
            })}
            {task.otherRequirements
              .filter((r) => !/loyalty level|reputation/i.test(r))
              .map((r) => (
                <li key={r} className="text-xs text-white/60">
                  ? {r} <span className="text-white/40">(not tracked; never locks it)</span>
                </li>
              ))}
            {delay && (
              <li className="text-xs text-white/60">
                Offered {Math.round(delay.minS / 3600)}–{Math.round(delay.maxS / 3600)} h after the quests before it are done.
              </li>
            )}
          </ul>
        </Section>
      )}
      {unlocks.length > 0 && (
        <Section title="Unlocks" count={unlocks.length}>
          <ul className="space-y-0.5">
            {unlocks.map((t) => (
              <li key={t.id}>
                <QuestLink task={t} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {task.wikiLink && (
        <Section title="Guide and location pictures">
          <GuidePictures task={task} />
        </Section>
      )}
    </>
  )
}

function KeyWikiInfo({ item, questNames }: { item: Item; questNames: string[] }) {
  const w = useKeyWiki(item.wikiLink)
  if (w.isPending) return <p className="text-xs text-white/55">Loading the wiki page…</p>
  if (!w.data) return <p className="text-xs text-white/55">No wiki page found for this key.</p>
  const v = keyVerdict({ behind: w.data.behind, questNames })
  const verdict =
    v.kind === 'quest'
      ? `Needed for ${questNames.join(', ')}${v.lootWorth ? '; also good loot' : ''}.`
      : v.kind === 'yes'
        ? `Worth it: ${v.reasons.slice(0, 3).join(', ')}.`
        : v.kind === 'no'
          ? `Not much behind it${v.reasons.length ? ` (${v.reasons.slice(0, 2).join(', ')})` : ''}.`
          : 'The wiki does not say what is behind it.'
  return (
    <div className="space-y-1.5 text-xs">
      <p className={v.kind === 'no' ? 'text-white/60' : 'text-green-300'}>{verdict}</p>
      {w.data.lockText.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-white/45">Where the lock is</div>
          {w.data.lockText.slice(0, 5).map((t, i) => (
            <p key={i} className="text-white/80">{t}</p>
          ))}
        </div>
      )}
      <Pictures images={w.data.lockImages} title={`${item.shortName}: the lock`} />
      {w.data.behind.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-white/45">Behind the lock</div>
          <ul>
            {w.data.behind.slice(0, 12).map((t, i) => (
              <li key={i} className="text-white/80">• {t}</li>
            ))}
          </ul>
        </div>
      )}
      <Pictures images={w.data.behindImages} title={`${item.shortName}: behind the lock`} />
      {w.data.keyText.length > 0 && (
        <div>
          <div className="text-[10px] uppercase tracking-wide text-white/45">Where the key itself is found (wiki)</div>
          {w.data.keyText.slice(0, 8).map((t, i) => (
            <p key={i} className={t.startsWith('## ') ? 'mt-1 font-medium text-white/85' : 'text-white/80'}>{t.replace(/^## /, '')}</p>
          ))}
        </div>
      )}
      <Pictures images={w.data.keyImages} title={`${item.shortName}: where it lies`} />
      <WikiCredit url={w.data.pageUrl} />
    </div>
  )
}

export function ItemDetails({ item }: { item: Item }) {
  const c = useDetails()
  const setCollected = useInventoryStore((s) => s.setCollected)
  const setKeyOwned = useInventoryStore((s) => s.setKeyOwned)
  const need = c.needs.get(item.id)
  const have = c.collected[item.id] ?? 0
  const remaining = need ? remainingFor(need, have) : 0
  const sell = [...item.sellToTrader].sort((a, b) => b.priceRUB - a.priceRUB)[0]
  const buy = item.buyFromTrader[0]
  const banned = item.types.includes('noFlea')
  const slots = Math.max(1, item.width * item.height)
  const isKey = item.types.includes('keys')
  const owned = c.ownedKeyIds.has(item.id)
  const keyMaps = isKey ? c.keyMaps(item) : []
  const net = !banned && item.avg24hPrice ? item.avg24hPrice - fleaFee(item.basePrice, item.avg24hPrice) : null
  const keyQuests = useMemo(
    () => (isKey ? c.data.tasks.filter((t) => !c.completed.has(t.id) && (t.neededKeys.some((k) => k.keyIds.includes(item.id)) || t.objectives.some((o) => o.requiredKeys.some((g) => g.includes(item.id))))) : []),
    [isKey, c.data.tasks, c.completed, item.id],
  )
  // Loose-loot spots per map (Night Factory is the same picture as Factory).
  const lootMaps = useMemo(() => {
    const out: { id: string; name: string; spots: { x: number; y: number; z: number }[] }[] = []
    for (const m of c.data.maps) {
      if (/night/i.test(m.normalizedName)) continue
      const spots = (c.data.mapDetails[m.id]?.lootLoose ?? []).filter((l) => l.itemIds.includes(item.id)).map((l) => l.position)
      if (spots.length) out.push({ id: m.id, name: m.name, spots })
    }
    return out.sort((a, b) => b.spots.length - a.spots.length)
  }, [c.data, item.id])
  const ammo = item.ammo
  return (
    <>
      <div className="flex gap-3">
        {item.iconLink && <img src={item.iconLink} alt="" className="h-14 w-14 shrink-0 object-contain" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium leading-snug">{item.name}</div>
          <div className="text-xs text-white/55">
            {item.shortName} · {item.width}×{item.height}
          </div>
        </div>
        <CopyButton text={item.name} />
        <StarButton r={{ kind: 'item', id: item.id, label: item.name }} />
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-white/50">Flea</dt>
        <dd className="tabular-nums">
          {banned ? "Can't be sold there" : item.avg24hPrice ? `${formatRoubles(item.avg24hPrice)}${item.lastLowPrice ? ` (lowest ${formatRoubles(item.lastLowPrice)})` : ''}` : '—'}
        </dd>
        {net !== null && (
          <>
            <dt className="text-white/50">You get</dt>
            <dd className="tabular-nums" title="Selling one at the 24 h average, after the flea fee">
              {formatRoubles(net)} <span className="text-white/45">after the fee</span>
            </dd>
          </>
        )}
        {!banned && item.avg24hPrice != null && slots > 1 && (
          <>
            <dt className="text-white/50">Per slot</dt>
            <dd className="tabular-nums">{formatRoubles(Math.round(item.avg24hPrice / slots))}</dd>
          </>
        )}
        {sell && (
          <>
            <dt className="text-white/50">Sell to</dt>
            <dd className="tabular-nums">
              {formatRoubles(sell.priceRUB)} <span className="text-white/50">({c.traderName(sell.traderId)})</span>
            </dd>
          </>
        )}
        {buy && (
          <>
            <dt className="text-white/50">Buy from</dt>
            <dd className="tabular-nums">
              {formatRoubles(buy.priceRUB)}{' '}
              <span className="text-white/50">
                ({c.traderName(buy.traderId)}
                {buy.minTraderLevel ? ` LL${buy.minTraderLevel}` : ''})
              </span>
            </dd>
          </>
        )}
        {!banned && item.fleaLevel != null && item.fleaLevel > 0 && (
          <>
            <dt className="text-white/50">Sell from</dt>
            <dd>level {item.fleaLevel}</dd>
          </>
        )}
        <dt className="text-white/50">Needed</dt>
        <dd>{need?.quantityUnknown || (need?.unknownFir ?? 0) > 0 ? 'Review unknown requirement details' : remaining > 0 ? `${remaining} more${(need?.fir ?? 0) > 0 ? ' (found in raid)' : ''}` : 'No additional tracked need'}</dd>
        {(need || have > 0) && (
          <>
            <dt className="text-white/50">You have</dt>
            <dd>
              <Stepper value={have} max={9999} label="Collected" onChange={(n) => setCollected(c.mode, item.id, n)} />
            </dd>
          </>
        )}
      </dl>
      {ammo && (
        <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px]">
          {[
            ['Damage', ammo.projectileCount > 1 ? `${ammo.damage}×${ammo.projectileCount}` : String(shotDamage(ammo))],
            ['Penetration', String(ammo.penetrationPower)],
            ['Armour dmg', `${ammo.armorDamage}%`],
            ['Frag chance', `${Math.round(ammo.fragmentationChance * 100)}%`],
            ['Speed', `${ammo.initialSpeed} m/s`],
            ['Good vs', `class ${bestArmorClass(ammo.penetrationPower)}`],
          ].map(([k, v]) => (
            <div key={k} className="rounded bg-white/5 px-1 py-0.5">
              <div className="text-white/45">{k}</div>
              <div className="tabular-nums">{v}</div>
            </div>
          ))}
          <div className="col-span-3 text-left">
            <ActionButton onClick={() => c.open({ kind: 'ammo', id: ammo.caliber })}>All {caliberLabel(ammo.caliber)} rounds</ActionButton>
            <span className="ml-1 text-[10px] text-white/40">"Good vs" is a rule of thumb (pen ≥ 10 × class).</span>
          </div>
        </div>
      )}
      {isKey && (
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-xs text-white/75">
          <input type="checkbox" checked={owned} onChange={(e) => setKeyOwned(c.mode, item.id, e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-accent)]" />
          I have this key (its doors turn green on maps)
        </label>
      )}
      {keyMaps.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {keyMaps.map((k) => (
            <ActionButton key={k.option.key} onClick={() => c.showKey(item, k)}>
              <MapIcon className="h-3 w-3" /> Lock on {k.option.name}
            </ActionButton>
          ))}
        </div>
      )}
      {need && need.sources.length > 0 && (
        <Section title="Needed for" count={need.sources.length} defaultOpen={remaining > 0}>
          <ul className="space-y-0.5">
            {need.sources.map((s, i) => (
              <li key={`${s.kind}:${s.id}:${i}`} className="flex items-center gap-1.5">
                <span className="shrink-0 tabular-nums text-white/55">{s.count ?? '?'}×</span>
                {s.kind === 'quest' && c.data.tasksById[s.id] ? (
                  <QuestLink task={c.data.tasksById[s.id]} />
                ) : s.kind === 'hideout' ? (
                  <button type="button" onClick={() => c.open({ kind: 'station', id: s.stationId })} className="min-w-0 truncate text-left hover:text-white hover:underline">
                    {s.name} level {s.level}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{s.name}</span>
                )}
                {'fir' in s && s.fir !== false && <span className="shrink-0 text-[10px] text-amber-300">{s.fir === true ? 'FIR' : 'FIR unknown'}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {keyQuests.length > 0 && (
        <Section title="Quests that need this key" count={keyQuests.length} defaultOpen>
          <ul className="space-y-0.5">
            {keyQuests.map((t) => (
              <li key={t.id}>
                <QuestLink task={t} />
              </li>
            ))}
          </ul>
        </Section>
      )}
      {lootMaps.length > 0 && (
        <Section title="Lies around on" count={lootMaps.length} defaultOpen={isKey}>
          <ul className="space-y-0.5 text-xs text-white/80">
            {lootMaps.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => c.openMap(m.id, { spot: { points: m.spots, label: `${item.shortName} can lie here` }, title: `${item.shortName} on ${m.name}` })} className="hover:text-white hover:underline">
                  {m.name} <span className="text-white/45">· {m.spots.length} spot{m.spots.length === 1 ? '' : 's'} · show</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-0.5 text-[10px] text-white/40">Loose-loot spots from tarkov.dev; chances are not in the data.</p>
        </Section>
      )}
      {!banned && (
        <Section title="Flea price, last 7 days">
          <PriceHistory itemId={item.id} />
        </Section>
      )}
      {isKey && item.wikiLink && (
        <Section title="Worth it? Lock, loot and key pictures">
          <KeyWikiInfo item={item} questNames={keyQuests.map((t) => t.name)} />
        </Section>
      )}
    </>
  )
}

/** Copies a name, to paste it into the flea search in game. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1500)
        })
      }
      title={copied ? 'Copied' : 'Copy the name (paste it into the flea search in game)'}
      aria-label="Copy the name"
      className={`shrink-0 p-0.5 ${copied ? 'text-green-300' : 'text-white/40 hover:text-white'}`}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  )
}

/** The flea average over the last week as a small line, with its low, high and change. */
function PriceHistory({ itemId }: { itemId: string }) {
  const h = usePriceHistory(itemId)
  const pts = useMemo(() => {
    const all = h.data ?? []
    const last = all.reduce((m, p) => Math.max(m, p.timestamp), 0)
    return all.filter((p) => p.timestamp >= last - 7 * 24 * 3600_000 && p.price > 0).sort((a, b) => a.timestamp - b.timestamp)
  }, [h.data])
  if (h.isPending) return <p className="text-xs text-white/55">Loading prices…</p>
  if (pts.length < 2) return <p className="text-xs text-white/55">No price history for this item.</p>
  const lo = Math.min(...pts.map((p) => p.price))
  const hi = Math.max(...pts.map((p) => p.price))
  const t0 = pts[0].timestamp
  const t1 = pts[pts.length - 1].timestamp
  const W = 300
  const H = 46
  const line = pts.map((p) => `${(((p.timestamp - t0) / Math.max(1, t1 - t0)) * W).toFixed(1)},${(H - 2 - ((p.price - lo) / Math.max(1, hi - lo)) * (H - 4)).toFixed(1)}`).join(' ')
  const change = (pts[pts.length - 1].price - pts[0].price) / pts[0].price
  return (
    <div className="text-[11px]">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-12 w-full" preserveAspectRatio="none" aria-label="Flea price over the last 7 days">
        <polyline points={line} fill="none" stroke="#e5c07b" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between tabular-nums text-white/60">
        <span>low {formatRoubles(lo)}</span>
        <span className={change >= 0 ? 'text-green-300' : 'text-red-300'}>
          {change >= 0 ? '+' : ''}
          {Math.round(change * 100)}% this week
        </span>
        <span>high {formatRoubles(hi)}</span>
      </div>
    </div>
  )
}

export function PictureDetails({ image }: { image: GuideImage }) {
  return (
    <>
      <WikiImage src={image.full} alt={image.caption} className="max-h-[60vh] w-full rounded object-contain" />
      {image.caption && <p className="mt-1 text-xs text-white/75">{image.caption}</p>}
      <button type="button" onClick={() => void window.desktop?.openExternal(image.full)} className="mt-1 inline-flex items-center gap-1 text-[11px] text-white/50 hover:text-white">
        Full size in the browser <ExternalLink className="h-3 w-3" />
      </button>
    </>
  )
}

/** "On map": the quest's spots are drawn on its map, here and on the app's Maps tab. */
export function OnMapBox({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1 px-2 text-[11px] text-white/60 hover:text-white" title="Show this quest's spots on its map, zoomed in (here and on the Maps tab)">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-[var(--color-accent)]" />
      On map
    </label>
  )
}

/** The button that opens something in a side panel (keeps the main card as it is). */
export function SideButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="shrink-0 px-1.5 text-white/45 hover:text-white">
      <PanelRightOpen className="h-3.5 w-3.5" />
    </button>
  )
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, BookOpen, DoorOpen, ExternalLink, GripVertical, HelpCircle, Home, Lock, Map as MapIcon, Search, Settings2, Skull, Star, Store, X } from 'lucide-react'
import { readOnlyPersistOptions } from '../api/persist'
import { queryClient } from '../api/queryClient'
import type { StoryData } from '../api/storyWiki'
import type { Item, Task } from '../api/types'
import { useNeeds } from '../hooks/useNeeds'
import { useProgressContext } from '../hooks/useProgressContext'
import { followOtherWindows } from '../lib/crossWindow'
import { caliberLabel } from '../lib/ammo'
import { fleaPurchaseAccess, type FleaRulesContext } from '../lib/economy'
import { formatRoubles } from '../lib/format'
import { computeTaskStatuses, isFactionEligible, STATUS_LABEL } from '../lib/taskStatus'
import { useMapOptions, type MapOption } from '../maps/useMapOptions'
import type { PlayerPosition } from '../shared/desktop-api'
import { useInventoryStore } from '../store/inventory'
import { usePrefs } from '../store/prefs'
import { useMapOverlayStore } from '../store/mapOverlay'
import { useProfile, useProgressStore } from '../store/progress'
import { useStoryStore } from '../store/story'
import { useUiStore } from '../store/ui'
import { ItemDetails, OnMapBox, PictureDetails, QuestDetails, SideButton } from './details'
import { DetailsContext, panelKey, type DetailsCtx, type KeyMap, type MapRequest, type View } from './detailsContext'
import { useFleaFees } from '../hooks/useFleaFees'
import { useFleaRules } from '../hooks/useFleaRules'
import { bossIndex, extractIndex, mapRows, raidMap, type MapRow, type RaidState } from './overlayLogic'
import { useOverlayPrefs, type Ref } from './overlayPrefs'
import type { Request } from './SearchBarApp'
import { MAP_ROWS_EVENT, MAP_ROWS_KEY, RESTOCKS_KEY } from './SearchBarApp'
import { hitKey, searchAll, type Hit, type SearchSource } from './search'
import { SettingsView } from './settingsView'
import { columnClass, type DragProps, type Flip } from './shell'
import { useTickedOnMap } from './tickedOnMap'
import { AmmoView, BossView, HelpView, HideoutView, PathView, QuestlineView, StationView, StoryView, TradersView, TraderView } from './views'

// The map (Leaflet) loads only when a map is opened.
const SearchBarMap = lazy(() => import('./SearchBarMap').then((m) => ({ default: m.SearchBarMap })))

/** Side panels at once (newest first). */
const MAX_PANELS = 3
const CARD_W = 'w-[372px]'

/** The tallest a card or the panel column may get (the window itself is capped by the screen). */
const heightCap = () => Math.max(240, Math.round(window.screen.availHeight * 0.8) - 70)

type Picked = { kind: 'view'; view: View } | { kind: 'map'; map: MapOption; req: MapRequest; nonce: number }

export interface BodyProps {
  flip: Flip
  expanded: boolean
  setExpanded: (on: boolean) => void
  glass: ReactElement
  strip: ReactNode
  grip: DragProps
  onState: (busy: boolean, clear: boolean, preview: boolean) => void
  raid: RaidState | null
  raidRow: MapRow | null
  request: Request | null
  locked: boolean
}

/** The app window's stores this bar shows and changes. */
const FOLLOWED = [useProgressStore, useInventoryStore, useMapOverlayStore, useUiStore, useStoryStore, usePrefs]

export default function SearchBarBody(props: BodyProps) {
  // After an unload the stores in this window may be older than what the app window saved since
  // (quests ticked from the game log): read them again before anything is shown or changed.
  useState(() => {
    for (const s of FOLLOWED) void s.persist.rehydrate()
    return true
  })
  // Ticks, levels and map choices made in the app window show here too (and the other way round).
  useEffect(() => followOtherWindows(FOLLOWED), [])
  // Unloaded after a while with nothing open: let the game data go with it.
  useEffect(() => () => queryClient.clear(), [])
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={readOnlyPersistOptions(queryClient)}>
      <Body {...props} />
    </PersistQueryClientProvider>
  )
}

function Body({ flip, expanded, setExpanded, glass, strip, grip, onState, raid, raidRow, request, locked }: BodyProps) {
  const { needs, gameData, hideout, items, inventory } = useNeeds()
  const feeContext = useFleaFees(items.data)
  const fleaRules = useFleaRules(items.data)
  const profile = useProfile()
  const mode = useProgressStore((s) => s.gameMode)
  const mapOptions = useMapOptions()
  const qc = useQueryClient()
  const onMap = useMapOverlayStore((s) => s.checkedTaskIds)
  const setOnMap = useMapOverlayStore((s) => s.setTaskChecked)
  const prefs = useOverlayPrefs()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [picked, setPicked] = useState<Picked | null>(null)
  const [panels, setPanels] = useState<View[]>([])
  const [preview, setPreview] = useState(false)
  // A screenshot position, and whether it just arrived (only a new one opens the raid's map).
  const [shot, setShot] = useState<{ pos: PlayerPosition; live: boolean } | null>(null)
  const position = shot?.pos ?? null
  const input = useRef<HTMLInputElement>(null)
  const data = gameData.data

  useEffect(() => {
    if (expanded) input.current?.focus()
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
      if ((e.key === '/' && !typing) || (e.key === 'f' && e.ctrlKey)) {
        e.preventDefault()
        input.current?.focus()
        input.current?.select()
      } else if (e.key === 'Escape' && !typing) {
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

  const mapShown = picked?.kind === 'map'
  useEffect(() => onState(mapShown || panels.length > 0, mapShown || panels.length > 0, preview), [onState, mapShown, panels.length, preview])

  // The map table for the raid pill (names and raid lengths), kept between starts.
  useEffect(() => {
    if (!data) return
    const rows = JSON.stringify(mapRows(data))
    const restocks = JSON.stringify(data.traders.filter((t) => t.resetTime).map((t) => ({ name: t.name, at: t.resetTime })))
    try {
      let changed = false
      if (localStorage.getItem(MAP_ROWS_KEY) !== rows) {
        localStorage.setItem(MAP_ROWS_KEY, rows)
        changed = true
      }
      if (localStorage.getItem(RESTOCKS_KEY) !== restocks) {
        localStorage.setItem(RESTOCKS_KEY, restocks)
        changed = true
      }
      if (changed) window.dispatchEvent(new Event(MAP_ROWS_EVENT))
    } catch {
      // only a convenience
    }
  }, [data])

  const tasks = useMemo(() => (data?.tasks ?? []).filter((t) => isFactionEligible(t, profile.faction)), [data, profile.faction])
  const progress = useProgressContext()
  const statuses = useMemo(() => computeTaskStatuses(tasks, profile, progress ?? undefined), [tasks, profile, progress])
  const itemList = useMemo(() => (items.data ? Object.values(items.data.items) : []), [items.data])
  const itemText = useMemo(() => new Map(itemList.map((it) => [it.id, `${it.name}\n${it.shortName}`.toLowerCase()])), [itemList])
  const bosses = useMemo(() => (data ? bossIndex(data) : []), [data])
  const extracts = useMemo(() => (data ? extractIndex(data).filter((e) => !/night/i.test(data.maps.find((m) => m.id === e.mapId)?.normalizedName ?? '')) : []), [data])
  const mapNameById = useMemo(() => new Map((data?.maps ?? []).map((m) => [m.id, m.name])), [data])
  const storyData = qc.getQueriesData<StoryData>({ queryKey: ['story'] }).find(([, d]) => d)?.[1]
  const calibers = useMemo(() => [...new Set(itemList.map((it) => it.ammo?.caliber).filter((c): c is string => Boolean(c)))].map((id) => ({ id, label: caliberLabel(id) })), [itemList])
  const storyList = useMemo(() => (storyData?.chapters ?? []).map((c) => ({ slug: c.slug, title: c.title.replace(/\s*\(story chapter\)/i, '') })), [storyData])
  const source = useMemo<SearchSource>(
    () => ({ maps: mapOptions, items: itemList, itemText, tasks, traders: data?.traders ?? [], bosses, extracts, mapNameById, stations: hideout.data ?? [], story: storyList, calibers }),
    [mapOptions, itemList, itemText, tasks, data, bosses, extracts, mapNameById, hideout.data, storyList, calibers],
  )
  const hits = useMemo(() => searchAll(query, source), [query, source])

  // --- Opening things -------------------------------------------------------
  const openPanel = useCallback((p: View) => setPanels((ps) => [p, ...ps.filter((x) => panelKey(x) !== panelKey(p))].slice(0, MAX_PANELS)), [])
  const closePanel = (p: View) => setPanels((ps) => ps.filter((x) => panelKey(x) !== panelKey(p)))
  const openMapOption = useCallback((option: MapOption, req: MapRequest = {}) => setPicked({ kind: 'map', map: option, req, nonce: Date.now() }), [])
  // A map opened: switch on the layers it asked for, and remember it.
  const shownMap = picked?.kind === 'map' ? picked : null
  useEffect(() => {
    if (!shownMap) return
    const st = useOverlayPrefs.getState()
    for (const l of shownMap.req.layers ?? []) st.toggleLayer(l, true)
    if (st.lastMapKey !== shownMap.map.key) st.set({ lastMapKey: shownMap.map.key })
  }, [shownMap])
  const openMap = useCallback(
    (mapId: string, req: MapRequest = {}) => {
      const option = mapOptions.find((m) => m.id === mapId)
      if (option) openMapOption(option, req)
    },
    [mapOptions, openMapOption],
  )
  // Ticking "On map" also opens that quest's map here, zoomed to it.
  const tickQuest = useCallback(
    (task: Task, on: boolean) => {
      setOnMap(task.id, on)
      if (!on) return
      const mapId = task.map?.id ?? task.objectives.flatMap((o) => o.maps)[0]?.id
      if (mapId) openMap(mapId, { focus: task.id })
    },
    [setOnMap, openMap],
  )
  const keyMaps = useCallback(
    (it: Item): KeyMap[] => {
      if (!data || !it.types.includes('keys')) return []
      return mapOptions
        .filter((m) => m.id && !/night/.test(m.key))
        .map((option) => {
          const details = data.mapDetails[option.id!]
          const locks = (details?.locks ?? []).filter((l) => l.keyId === it.id).map((l) => ({ position: l.position, label: `Lock: ${it.shortName}`, kind: 'lock' as const }))
          const spawns = (details?.lootLoose ?? []).filter((l) => l.itemIds.includes(it.id)).map((l) => ({ position: l.position, label: `${it.shortName} lies here`, kind: 'spawn' as const }))
          return { option, pins: [...locks, ...spawns] }
        })
        .filter((x) => x.pins.some((p) => p.kind === 'lock'))
    },
    [data, mapOptions],
  )
  const showKey = useCallback((it: Item, k: KeyMap) => openMapOption(k.option, { pins: k.pins, title: `${it.shortName}: lock${k.pins.filter((p) => p.kind === 'lock').length > 1 ? 's' : ''} on ${k.option.name}` }), [openMapOption])
  const traderName = useCallback((id: string) => data?.traders.find((t) => t.id === id)?.name ?? 'Trader', [data])
  const starred = useCallback((kind: Ref['kind'], id: string) => prefs.stars.some((s) => s.kind === kind && s.id === id), [prefs.stars])

  // A hit from the list: the main card shows it (maps open their map card).
  const pick = (h: Hit) => {
    const add = prefs.addRecent
    switch (h.kind) {
      case 'map':
        add({ kind: 'map', id: h.map.key, label: h.map.name })
        return openMapOption(h.map)
      case 'extract':
        return openMap(h.extract.mapId, { spot: { points: [h.extract.position], label: h.extract.name }, title: `${h.extract.name} · ${h.mapName}`, layers: [h.extract.faction === 'scav' ? 'extractsScav' : 'extractsPmc'] })
      case 'item':
        add({ kind: 'item', id: h.item.id, label: h.item.name })
        return setPicked({ kind: 'view', view: { kind: 'item', id: h.item.id } })
      case 'quest':
        add({ kind: 'quest', id: h.task.id, label: h.task.name })
        return setPicked({ kind: 'view', view: { kind: 'quest', id: h.task.id } })
      case 'trader':
        add({ kind: 'trader', id: h.trader.id, label: h.trader.name })
        return setPicked({ kind: 'view', view: { kind: 'trader', id: h.trader.id } })
      case 'boss':
        add({ kind: 'boss', id: h.boss.key, label: h.boss.name })
        return setPicked({ kind: 'view', view: { kind: 'boss', id: h.boss.key } })
      case 'station':
        add({ kind: 'station', id: h.station.id, label: h.station.name })
        return setPicked({ kind: 'view', view: { kind: 'station', id: h.station.id } })
      case 'story':
        return setPicked({ kind: 'view', view: { kind: 'story', id: h.slug } })
      case 'ammo':
        return setPicked({ kind: 'view', view: { kind: 'ammo', id: h.id } })
      case 'special':
        return setPicked({ kind: 'view', view: h.view })
    }
  }
  const sideOf = (h: Hit): View | null =>
    h.kind === 'item'
      ? { kind: 'item', id: h.item.id }
      : h.kind === 'quest'
        ? { kind: 'quest', id: h.task.id }
        : h.kind === 'trader'
          ? { kind: 'trader', id: h.trader.id }
          : h.kind === 'boss'
            ? { kind: 'boss', id: h.boss.key }
            : h.kind === 'station'
              ? { kind: 'station', id: h.station.id }
              : h.kind === 'special'
                ? h.view
                : h.kind === 'ammo'
                  ? { kind: 'ammo', id: h.id }
                  : null

  // Starred things and recent picks, shown while the search box is empty.
  const refHit = (r: Ref): Hit | null => {
    if (r.kind === 'item') return items.data?.items[r.id] ? { kind: 'item', item: items.data.items[r.id] } : null
    if (r.kind === 'quest') return data?.tasksById[r.id] ? { kind: 'quest', task: data.tasksById[r.id] } : null
    if (r.kind === 'map') {
      const m = mapOptions.find((o) => o.key === r.id)
      return m ? { kind: 'map', map: m } : null
    }
    if (r.kind === 'trader') {
      const t = data?.traders.find((x) => x.id === r.id)
      return t ? { kind: 'trader', trader: t } : null
    }
    if (r.kind === 'boss') {
      const b = bosses.find((x) => x.key === r.id)
      return b ? { kind: 'boss', boss: b } : null
    }
    const s = hideout.data?.find((x) => x.id === r.id)
    return s ? { kind: 'station', station: s } : null
  }
  const starHits = prefs.stars.map(refHit).filter((h): h is Hit => h !== null)
  const recentHits = prefs.recent
    .map(refHit)
    .filter((h): h is Hit => h !== null && !starHits.some((s) => hitKey(s) === hitKey(h)))
    .slice(0, 6)

  // --- Requests from outside: the raid pill, a new raid, the search hotkey --------
  const raidOption = useMemo(() => {
    const row = raidRow ?? (data ? raidMap(raid, mapRows(data)) : null)
    return row ? mapOptions.find((m) => m.key === row.key) ?? null : null
  }, [raid, raidRow, data, mapOptions])
  // Handled while drawing, once each: the raid's map (pill, new raid) or the last map at start.
  const [seenRequest, setSeenRequest] = useState(0)
  if (request && request.kind === 'mapToggle' && request.nonce !== seenRequest && (picked?.kind === 'map' || mapOptions.some((o) => o.id))) {
    setSeenRequest(request.nonce)
    if (picked?.kind === 'map') setPicked(null)
    else {
      const target = raidOption ?? mapOptions.find((o) => o.key === prefs.lastMapKey && o.id) ?? mapOptions.find((o) => o.id)
      if (target) setPicked({ kind: 'map', map: target, req: {}, nonce: request.nonce })
    }
  } else if (request && request.kind !== 'focus' && request.kind !== 'mapToggle' && request.nonce !== seenRequest) {
    const target = request.kind === 'raidMap' ? raidOption : mapOptions.find((o) => o.key === prefs.lastMapKey && o.id)
    if (target) {
      setSeenRequest(request.nonce)
      if (!(picked?.kind === 'map' && picked.map.key === target.key)) setPicked({ kind: 'map', map: target, req: {}, nonce: request.nonce })
    } else if (request.kind === 'restore' && mapOptions.some((o) => o.id)) setSeenRequest(request.nonce)
  }
  useEffect(() => {
    if (request?.kind !== 'focus') return
    input.current?.focus()
    input.current?.select()
  }, [request])

  // Your position from in-game screenshots (only while a raid's map is known).
  useEffect(() => {
    const api = window.desktop
    if (!api) return
    void api.getLatestPosition().then((p) => p && setShot((s) => s ?? { pos: p, live: false }))
    return api.onPosition((p) => setShot({ pos: p, live: true }))
  }, [])
  const followPosition = prefs.followPosition
  // A new screenshot in this raid: show the raid's map with the arrow (once per screenshot).
  const [seenPos, setSeenPos] = useState(0)
  if (position && shot?.live && followPosition && raid && raidOption && position.at !== seenPos && position.at >= raid.since) {
    setSeenPos(position.at)
    if (!(picked?.kind === 'map' && picked.map.key === raidOption.key)) setPicked({ kind: 'map', map: raidOption, req: {}, nonce: position.at })
  }
  const positionFor = (option: MapOption) => (followPosition && position && raid && raidOption?.key === option.key && position.at >= raid.since ? position : null)

  const ctx = useMemo<DetailsCtx | null>(
    () =>
      data
        ? {
            data,
            items: items.data?.items,
            feeContext,
            fleaRules,
            stations: hideout.data ?? [],
            statuses,
            completed: progress?.completed ?? profile.completedTaskIds,
            progress,
            needs,
            collected: inventory.collected,
            ownedKeyIds: new Set(inventory.ownedKeyIds),
            stationLevels: inventory.stationLevels,
            traderLevels: progress?.traderLevel ?? inventory.traderLevels,
            mode,
            onMap,
            tickQuest,
            keyMaps,
            showKey,
            openMap,
            open: openPanel,
            star: prefs.toggleStar,
            starred,
            traderName,
          }
        : null,
    [data, items.data, feeContext, fleaRules, hideout.data, statuses, profile.completedTaskIds, progress, needs, inventory, mode, onMap, tickQuest, keyMaps, showKey, openMap, openPanel, prefs.toggleStar, starred, traderName],
  )

  const clear = () => {
    setQuery('')
    setPicked(null)
    setCursor(0)
  }
  const openInApp = (v: View | Picked) => {
    const t = stamp()
    const q = (o: Record<string, string>) => new URLSearchParams({ ...o, t }).toString()
    let to: string | null = null
    if (v.kind === 'map') to = `/maps?${q({ map: v.map.key })}`
    else if (v.kind === 'view') return openInApp(v.view)
    else if (v.kind === 'quest') to = `/quests?${q({ q: data?.tasksById[v.id]?.name ?? '' })}`
    else if (v.kind === 'item') {
      const it = items.data?.items[v.id]
      if (it) to = it.types.includes('keys') ? `/keys?${q({ key: it.id })}` : `/flea?${q({ q: it.name })}`
    } else if (v.kind === 'questline' || v.kind === 'kappa' || v.kind === 'lightkeeper') to = '/quests'
    else if (v.kind === 'trader' || v.kind === 'traders') to = '/flea'
    else if (v.kind === 'station' || v.kind === 'hideout') to = '/hideout'
    else if (v.kind === 'ammo') to = '/ammo'
    else if (v.kind === 'story') to = '/story'
    else if (v.kind === 'picture') return void window.desktop?.openExternal(v.image.full)
    if (to) void window.desktop?.openInApp(to)
  }

  const renderView = (v: View): ReactNode => {
    switch (v.kind) {
      case 'quest': {
        const task = data?.tasksById[v.id]
        return task ? <QuestDetails task={task} /> : <Gone />
      }
      case 'item': {
        const it = items.data?.items[v.id]
        return it ? <ItemDetails item={it} /> : <Gone />
      }
      case 'picture':
        return <PictureDetails image={v.image} />
      case 'questline':
        return <QuestlineView id={v.id} />
      case 'trader':
        return <TraderView id={v.id} />
      case 'traders':
        return <TradersView />
      case 'boss':
        return <BossView id={v.id} />
      case 'station':
        return <StationView id={v.id} />
      case 'hideout':
        return <HideoutView />
      case 'ammo':
        return <AmmoView id={v.id} />
      case 'kappa':
        return <PathView which="kappa" />
      case 'lightkeeper':
        return <PathView which="lightkeeper" />
      case 'story':
        return <StoryView id={v.id} />
      case 'settings':
        return <SettingsView onPreview={setPreview} />
      case 'help':
        return <HelpView />
    }
  }
  const viewTitle = (v: View): string => {
    switch (v.kind) {
      case 'quest':
        return data?.tasksById[v.id]?.name ?? 'Quest'
      case 'item':
        return items.data?.items[v.id]?.shortName ?? 'Item'
      case 'picture':
        return v.title
      case 'questline':
        return 'Questline'
      case 'trader':
        return traderName(v.id)
      case 'traders':
        return 'Restocks'
      case 'boss':
        return bosses.find((b) => b.key === v.id)?.name ?? 'Boss'
      case 'station':
        return hideout.data?.find((s) => s.id === v.id)?.name ?? 'Hideout'
      case 'hideout':
        return 'Hideout'
      case 'ammo':
        return 'Ammo'
      case 'kappa':
        return 'Kappa'
      case 'lightkeeper':
        return 'Lightkeeper'
      case 'story':
        return 'Story'
      case 'settings':
        return 'Settings'
      case 'help':
        return 'Help'
    }
  }

  const showList = expanded && !picked
  const cap = heightCap()
  const zoom = prefs.scale / 100
  const loadingText = items.isPending || gameData.isPending ? 'Loading the game data…' : 'Nothing matches.'

  const bar = (
    <div data-solid className={`sb-z flex ${CARD_W} items-center gap-1.5 rounded-lg border border-white/15 bg-black/80 py-2 pl-1 pr-2 shadow-2xl`} style={{ zoom }}>
      <span {...grip} title="Drag to move" aria-label="Drag to move the search bar" className="flex shrink-0 cursor-grab touch-none items-center text-white/35 hover:text-white active:cursor-grabbing">
        <GripVertical className="h-4 w-4" />
      </span>
      <Search className="h-4 w-4 shrink-0 text-white/60" />
      <input
        ref={input}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setPicked(null)
          setCursor(0)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setCursor((c) => Math.min(hits.length - 1, c + 1))
          else if (e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1))
          else if (e.key === 'Enter') {
            const h = hits[cursor]
            if (h) pick(h)
          } else if (e.key === 'Escape') {
            if (picked) setPicked(null)
            else if (query) clear()
            else {
              setExpanded(false)
              void window.desktop?.releaseSearchBar()
            }
          } else return
          e.preventDefault()
        }}
        placeholder={items.isPending ? 'Loading items…' : 'Maps, items, keys, quests, bosses, traders…'}
        aria-label="Search maps, items, keys and quests"
        className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/45 focus:outline-none"
      />
      {query && (
        <button type="button" onClick={clear} aria-label="Clear" className="rounded p-0.5 text-white/55 hover:text-white">
          <X className="h-4 w-4" />
        </button>
      )}
      <button type="button" onClick={() => setPicked({ kind: 'view', view: { kind: 'help' } })} aria-label="What it can do" title="What it can do" className="rounded p-0.5 text-white/55 hover:text-white">
        <HelpCircle className="h-4 w-4" />
      </button>
      <button type="button" onClick={() => setPicked({ kind: 'view', view: { kind: 'settings' } })} aria-label="Search bar settings" title="Settings: see-through, size, hotkeys, position" className="rounded p-0.5 text-white/55 hover:text-white">
        <Settings2 className="h-4 w-4" />
      </button>
    </div>
  )

  const hitRow = (h: Hit, i: number, active: boolean) => (
    <li key={hitKey(h)} role="option" aria-selected={active} className={`flex items-center ${active ? 'bg-white/10' : ''}`}>
      <button type="button" onMouseEnter={() => i >= 0 && setCursor(i)} onClick={() => pick(h)} className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1 text-left">
        <HitIcon h={h} />
        <span className="min-w-0 flex-1 truncate">{hitLabel(h)}</span>
        <span className="shrink-0 text-xs tabular-nums text-white/55">{hitNote(h, statuses, fleaRules)}</span>
      </button>
      {h.kind === 'quest' && <OnMapBox checked={onMap.includes(h.task.id)} onChange={(on) => tickQuest(h.task, on)} />}
      {sideOf(h) && <SideButton label="Open beside" onClick={() => openPanel(sideOf(h)!)} />}
    </li>
  )

  return (
    <DetailsContext.Provider value={ctx}>
      <div className={columnClass(flip)}>
        {expanded ? bar : glass}
        {expanded && strip}

        {showList && query.trim().length > 0 && (
          <ul data-solid role="listbox" aria-label="Results" className={`sb-z ${CARD_W} overflow-hidden rounded-lg border border-white/15 bg-black/85 py-1 shadow-2xl`} style={{ zoom }}>
            {hits.length === 0 && <li className="px-3 py-2 text-white/55">{loadingText}</li>}
            {hits.map((h, i) => hitRow(h, i, i === cursor))}
          </ul>
        )}
        {showList && query.trim().length === 0 && (
          <ul data-solid aria-label="Quick start, starred and recent" className={`sb-z ${CARD_W} overflow-y-auto rounded-lg border border-white/15 bg-black/85 py-1 shadow-2xl [scrollbar-width:thin]`} style={{ zoom, maxHeight: cap / zoom }}>
            <li className="px-3 pt-0.5 text-[10px] uppercase tracking-wide text-white/40">Maps</li>
            <li className="flex flex-wrap gap-1 px-3 py-1">
              {mapOptions
                .filter((m) => m.id && !/night/.test(m.key))
                .map((m) => (
                  <button key={m.key} type="button" onClick={() => openMapOption(m)} className={`rounded border px-1.5 py-0.5 text-[11px] hover:bg-white/15 ${raidOption?.key === m.key ? 'border-amber-300/60 text-amber-100' : 'border-white/15 text-white/80'}`}>
                    {m.name}
                  </button>
                ))}
            </li>
            <li className="flex flex-wrap gap-1 px-3 pb-1">
              {QUICK_PAGES.map((q) => (
                <button key={q.label} type="button" onClick={() => setPicked({ kind: 'view', view: q.view })} className="rounded border border-white/15 px-1.5 py-0.5 text-[11px] text-white/70 hover:bg-white/15 hover:text-white">
                  {q.label}
                </button>
              ))}
            </li>
            {data?.goonReport && (
              <li className="px-3 pb-1 text-[11px] text-amber-200/90">
                Goons last reported on {mapNameById.get(data.goonReport.mapId) ?? 'a map'} · {agoText(data.goonReport.at)}
              </li>
            )}
            {raidOption && (
              <>
                <li className="px-3 pt-0.5 text-[10px] uppercase tracking-wide text-white/40">This raid</li>
                {hitRow({ kind: 'map', map: raidOption }, -1, false)}
              </>
            )}
            {starHits.length > 0 && <li className="flex items-center gap-1 px-3 pt-0.5 text-[10px] uppercase tracking-wide text-white/40"><Star className="h-3 w-3" /> Starred</li>}
            {starHits.map((h) => hitRow(h, -1, false))}
            {recentHits.length > 0 && <li className="px-3 pt-0.5 text-[10px] uppercase tracking-wide text-white/40">Recent</li>}
            {recentHits.map((h) => hitRow(h, -1, false))}
          </ul>
        )}

        {picked?.kind === 'map' && (
          <MapCard
            key={`${picked.map.key}:${picked.nonce}`}
            option={picked.map}
            req={picked.req}
            flip={flip}
            zoom={zoom}
            locked={locked}
            position={positionFor(picked.map)}
            starred={starred('map', picked.map.key)}
            onStar={() => prefs.toggleStar({ kind: 'map', id: picked.map.key, label: picked.map.name })}
            maps={mapOptions}
            onSwitch={(m) => openMapOption(m)}
            onBack={() => setPicked(null)}
            onOpen={() => openInApp(picked)}
          />
        )}
        {expanded && ctx && picked?.kind === 'view' && (
          <div data-solid className={`sb-z ${CARD_W} overflow-y-auto rounded-lg border border-white/15 bg-black/85 p-3 shadow-2xl [scrollbar-width:thin]`} style={{ maxHeight: cap / zoom, zoom }}>
            {renderView(picked.view)}
            <div className="mt-2 flex items-center justify-between gap-2 text-xs">
              <button type="button" onClick={() => setPicked(null)} className="inline-flex items-center gap-1 text-white/60 hover:text-white">
                <ArrowLeft className="h-3 w-3" /> Back
              </button>
              <button type="button" onClick={() => openPanel(picked.view)} className="inline-flex items-center gap-1 text-white/60 hover:text-white" title="Keep it beside the search">
                Pin beside
              </button>
              {picked.view.kind !== 'settings' && picked.view.kind !== 'help' && (
                <button type="button" onClick={() => openInApp(picked)} className="inline-flex items-center gap-1 text-white/60 hover:text-white">
                  Open in the app <ExternalLink className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {ctx && panels.length > 0 && (
        <div className={`sb-z flex flex-col gap-1 ${flip.up ? 'flex-col-reverse' : ''}`} style={{ width: prefs.panelW, maxHeight: (cap + 60) / zoom, zoom }}>
          {panels.length > 1 && (
            <button data-solid type="button" onClick={() => setPanels([])} className="self-end rounded border border-white/15 bg-black/80 px-2 py-0.5 text-[11px] text-white/60 shadow-xl hover:text-white">
              Close all {panels.length}
            </button>
          )}
          {panels.map((p) => (
            <PanelFrame key={panelKey(p)} title={viewTitle(p)} onClose={() => closePanel(p)} onOpen={p.kind === 'settings' || p.kind === 'help' ? undefined : () => openInApp(p)}>
              {renderView(p)}
            </PanelFrame>
          ))}
        </div>
      )}
    </DetailsContext.Provider>
  )
}

/** A fresh value per "Open in the app", so the same page opens again. */
const stamp = () => String(Date.now())

/** "3 h ago" for a report time (read when drawn; a report is hours old, so minutes do not matter). */
const agoText = (at: number) => {
  const h = Math.round((Date.now() - at) / 3600_000)
  return h < 1 ? 'less than an hour ago' : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/** Shortcut pages on the empty search card. */
const QUICK_PAGES: { label: string; view: View }[] = [
  { label: 'Kappa', view: { kind: 'kappa' } },
  { label: 'Lightkeeper', view: { kind: 'lightkeeper' } },
  { label: 'Restocks', view: { kind: 'traders' } },
  { label: 'Hideout', view: { kind: 'hideout' } },
  { label: 'Story', view: { kind: 'story', id: null } },
  { label: 'Settings', view: { kind: 'settings' } },
  { label: 'Help', view: { kind: 'help' } },
]

function Gone() {
  return <p className="text-white/55">Not in the data any more.</p>
}

function hitLabel(h: Hit): string {
  switch (h.kind) {
    case 'map':
      return h.map.name
    case 'item':
      return h.item.name
    case 'quest':
      return h.task.name
    case 'trader':
      return h.trader.name
    case 'boss':
      return h.boss.name
    case 'extract':
      return h.extract.name
    case 'station':
      return h.station.name
    case 'story':
      return h.title
    case 'special':
    case 'ammo':
      return h.kind === 'ammo' ? `All ${h.label} rounds` : h.label
  }
}

function hitNote(h: Hit, statuses: Record<string, string>, fleaRules: FleaRulesContext | null): string {
  switch (h.kind) {
    case 'map':
      return 'map'
    case 'item': {
      if (h.item.types.includes('noFlea')) return 'no flea'
      if (!h.item.avg24hPrice) return '—'
      // A catalog average is not a price this character can pay.
      return fleaPurchaseAccess(h.item, fleaRules).available ? formatRoubles(h.item.avg24hPrice) : 'locked'
    }
    case 'quest':
      return STATUS_LABEL[(statuses[h.task.id] as keyof typeof STATUS_LABEL) ?? 'locked']
    case 'trader':
      return 'trader'
    case 'boss':
      return h.boss.maps[0] ? `${Math.round(h.boss.maps[0].chance * 100)}% top map` : 'boss'
    case 'extract':
      return `${h.extract.faction === 'pmc' ? 'PMC' : h.extract.faction === 'scav' ? 'Scav' : 'both'} · ${h.mapName}`
    case 'station':
      return 'hideout'
    case 'story':
      return 'story'
    case 'special':
      return h.hint
    case 'ammo':
      return 'ammo table'
  }
}

function HitIcon({ h }: { h: Hit }) {
  const box = 'flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/10 text-white/80'
  if (h.kind === 'item') return h.item.iconLink ? <img src={h.item.iconLink} alt="" className="h-6 w-6 shrink-0 object-contain" loading="lazy" /> : <span className="h-6 w-6 shrink-0" />
  if (h.kind === 'trader' && h.trader.imageLink) return <img src={h.trader.imageLink} alt="" className="h-6 w-6 shrink-0 rounded object-cover" loading="lazy" />
  if (h.kind === 'boss' && h.boss.portrait) return <img src={h.boss.portrait} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" loading="lazy" />
  const Icon = h.kind === 'map' ? MapIcon : h.kind === 'extract' ? DoorOpen : h.kind === 'boss' ? Skull : h.kind === 'trader' ? Store : h.kind === 'station' ? Home : h.kind === 'story' ? BookOpen : null
  if (Icon)
    return (
      <span className={box}>
        <Icon className="h-3.5 w-3.5" />
      </span>
    )
  return <span className={`${box} text-[10px]`}>{h.kind === 'quest' ? 'Q' : h.kind === 'ammo' ? '•••' : '★'}</span>
}

function PanelFrame({ title, onClose, onOpen, children }: { title: string; onClose: () => void; onOpen?: () => void; children: ReactNode }) {
  return (
    <section data-solid className="flex min-h-0 shrink flex-col rounded-lg border border-white/15 bg-black/85 shadow-2xl">
      <header className="flex items-center gap-1 border-b border-white/10 px-2.5 py-1">
        <span className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-wide text-white/55">{title}</span>
        {onOpen && (
          <button type="button" onClick={onOpen} title="Open in the app" aria-label="Open in the app" className="p-0.5 text-white/45 hover:text-white">
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
        )}
        <button type="button" onClick={onClose} title="Close" aria-label="Close this panel" className="p-0.5 text-white/45 hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="min-h-0 overflow-y-auto p-2.5 [scrollbar-width:thin]">{children}</div>
    </section>
  )
}

function MapCard({
  option,
  req,
  flip,
  zoom,
  locked,
  position,
  starred,
  onStar,
  maps,
  onSwitch,
  onBack,
  onOpen,
}: {
  maps: MapOption[]
  onSwitch: (m: MapOption) => void
  option: MapOption
  req: MapRequest
  flip: Flip
  zoom: number
  locked: boolean
  position: PlayerPosition | null
  starred: boolean
  onStar: () => void
  onBack: () => void
  onOpen: () => void
}) {
  const ticked = useTickedOnMap(option)
  const hint = req.pins?.length ? 'Red = lock, green = where it lies' : position ? 'Arrow = your last screenshot' : ticked ? `${ticked} quest${ticked === 1 ? '' : 's'} shown` : 'Tick quests in the list'
  return (
    <div data-solid className="w-max rounded-lg border border-white/20 bg-black/85 p-2 shadow-2xl">
      <div className="sb-z mb-1.5 flex items-center gap-1.5 px-1" style={{ zoom }}>
        <button type="button" onClick={onBack} title="Back to the results" aria-label="Back" className="p-0.5 text-white/55 hover:text-white">
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        {req.title ? (
          <span className="min-w-0 flex-1 truncate font-medium">{req.title}</span>
        ) : (
          <select
            value={option.key}
            onChange={(e) => {
              const m = maps.find((o) => o.key === e.target.value)
              if (m) onSwitch(m)
            }}
            aria-label="Switch map"
            title="Switch map"
            className="min-w-0 flex-1 cursor-pointer truncate bg-transparent font-medium text-white [color-scheme:dark] focus:outline-none"
          >
            {maps
              .filter((m) => m.id && !/night/.test(m.key))
              .map((m) => (
                <option key={m.key} value={m.key} className="bg-neutral-900">
                  {m.name}
                </option>
              ))}
          </select>
        )}
        <span className="shrink-0 truncate text-[11px] text-white/55">{hint}</span>
        <button type="button" onClick={onStar} title={starred ? 'Remove the star' : 'Star this map'} aria-label="Star" className={`p-0.5 ${starred ? 'text-amber-300' : 'text-white/45 hover:text-white'}`}>
          <Star className={`h-3.5 w-3.5 ${starred ? 'fill-amber-300' : ''}`} />
        </button>
        <button type="button" onClick={() => void window.desktop?.setSearchBarLocked(!locked)} title={locked ? 'Unlock' : 'Lock: every click goes through to the game (unlock with the hotkey or the tray icon)'} aria-label="Lock" className={`p-0.5 ${locked ? 'text-amber-300' : 'text-white/45 hover:text-white'}`}>
          <Lock className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onOpen} title="Open in the app" aria-label="Open in the app" className="p-0.5 text-white/45 hover:text-white">
          <ExternalLink className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={onBack} title="Close the map" aria-label="Close the map" className="p-0.5 text-white/45 hover:text-white">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <Suspense fallback={<div className="h-72 w-[356px] rounded-md bg-white/5" />}>
        <SearchBarMap option={option} pins={req.pins} focus={req.focus} spot={req.spot} flip={flip} position={position} />
      </Suspense>
    </div>
  )
}

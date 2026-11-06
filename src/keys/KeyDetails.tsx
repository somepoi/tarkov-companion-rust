import { useEffect, useMemo, useState } from 'react'
import L from 'leaflet'
import { CircleMarker, Marker, Tooltip, useMap } from 'react-leaflet'
import { CheckCircle2, ExternalLink, HelpCircle, KeyRound, Loader2, ScrollText, X, XCircle } from 'lucide-react'
import type { GameData, Item, MapLock, Position } from '../api/types'
import { useKeyWiki } from '../api/wikiKey'
import type { GuideImage } from '../api/wikiGuide'
import { Lightbox } from '../components/QuestGuide'
import { formatRoubles } from '../lib/format'
import { keyVerdict } from '../lib/keyVerdict'
import { keySpawnsByMap } from '../lib/keySpawns'
import { MapViewer } from '../maps/MapViewer'
import { findMapConfig, resolveBaseLayer, type BaseLayerConfig } from '../maps/mapConfig'
import { floorForPosition } from '../maps/overlay/floors'
import { layerIcon } from '../maps/overlay/objectiveIcons'
import { useUiStore } from '../store/ui'
import { WikiImage } from '../components/WikiImage'

export interface KeyDetailsRow {
  item: Item
  quests: { id: string; name: string }[]
}

/** Locks this key opens, grouped per map picture (Factory and Night Factory share one). */
function locksByMap(data: GameData, keyId: string) {
  const out: { configKey: string; mapName: string; normalizedName: string; locks: MapLock[] }[] = []
  for (const m of data.maps) {
    const locks = (data.mapDetails[m.id]?.locks ?? []).filter((l) => l.keyId === keyId)
    if (!locks.length) continue
    const cfg = findMapConfig(m.normalizedName)
    if (!cfg || out.some((o) => o.configKey === cfg.key)) continue
    out.push({ configKey: cfg.key, mapName: m.name, normalizedName: m.normalizedName, locks })
  }
  return out
}

/** Zooms to the marked spots once the map is ready. */
function FitPoints({ points, layer }: { points: Position[]; layer: BaseLayerConfig }) {
  const map = useMap()
  useEffect(() => {
    const pts = points.map((p) => L.latLng(p.z, p.x))
    // One step out from full detail: the building and its surroundings, not just the door.
    if (pts.length === 1) map.setView(pts[0], Math.min(map.getMaxZoom(), layer.maxZoom - 0.5), { animate: false })
    else map.fitBounds(L.latLngBounds(pts).pad(0.6), { animate: false, maxZoom: layer.maxZoom - 0.5 })
  }, [map, points, layer])
  return null
}

interface KeyMarker {
  id: string
  position: Position
  kind: 'lock' | 'spawn'
  label: string
}

const SPAWN_STYLE = { color: '#0b0b0b', weight: 1.5, fillColor: '#22c55e', fillOpacity: 0.95 }

function KeyMap({ normalizedName, configKey, markers }: { normalizedName: string; configKey: string; markers: KeyMarker[] }) {
  const preferred = useUiStore((s) => s.baseLayerByMap[configKey])
  const points = useMemo(() => markers.map((m) => m.position), [markers])
  const cfg = findMapConfig(normalizedName)
  if (!cfg || !markers.length) return null
  const layer = resolveBaseLayer(cfg, preferred)
  const floor = floorForPosition(layer, markers[0].position)
  const permanent = markers.length <= 3
  return (
    <div className="h-72 overflow-hidden rounded border border-line">
      <MapViewer mapKey={`key:${configKey}:${markers.map((m) => m.id).join(',')}`} layer={layer} floorName={floor}>
        <FitPoints points={points} layer={layer} />
        {markers.map((m) =>
          m.kind === 'lock' ? (
            <Marker key={m.id} position={[m.position.z, m.position.x]} icon={layerIcon('lock', '#f59e0b')} zIndexOffset={1000}>
              <Tooltip direction="top" offset={[0, -10]} permanent={permanent}>
                {m.label}
              </Tooltip>
            </Marker>
          ) : (
            <CircleMarker key={m.id} center={[m.position.z, m.position.x]} radius={7} pathOptions={SPAWN_STYLE}>
              <Tooltip direction="top" offset={[0, -6]} permanent={permanent}>
                {m.label}
              </Tooltip>
            </CircleMarker>
          ),
        )}
      </MapViewer>
    </div>
  )
}

const lockMarkers = (locks: MapLock[], keyName: string): KeyMarker[] =>
  locks.map((l) => ({
    id: l.id,
    position: l.position,
    kind: 'lock',
    label: `${keyName.replace(/ key$/i, '')}${l.lockType && l.lockType !== 'door' ? ` (${l.lockType})` : ''}${l.needsPower ? ' · needs power' : ''}`,
  }))

/** Wiki lines where "## Shoreline" starts a map. */
function WikiLines({ lines }: { lines: string[] }) {
  return (
    <div className="space-y-1 text-sm">
      {lines.map((t, i) => (t.startsWith('## ') ? <p key={i} className="pt-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">{t.slice(3)}</p> : <p key={i}>{t}</p>))}
    </div>
  )
}

function Thumbs({ images, onOpen }: { images: GuideImage[]; onOpen: (img: GuideImage) => void }) {
  if (!images.length) return null
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {images.map((img) => (
        <button key={img.full} type="button" onClick={() => onOpen(img)} className="group overflow-hidden rounded border border-line bg-surface text-left hover:border-accent">
          <WikiImage src={img.thumb} alt={img.caption} loading="lazy" className="h-28 w-full object-cover" />
          {img.caption && <span className="block truncate px-1.5 py-1 text-[11px] text-ink-muted group-hover:text-ink">{img.caption}</span>}
        </button>
      ))}
    </div>
  )
}

const VERDICT_STYLE = {
  quest: { icon: ScrollText, cls: 'border-info/60 bg-info/10 text-info', label: 'Quest key' },
  yes: { icon: CheckCircle2, cls: 'border-success/60 bg-success/10 text-success', label: 'Worth it' },
  no: { icon: XCircle, cls: 'border-danger/60 bg-danger/10 text-danger', label: 'Not worth it' },
  unknown: { icon: HelpCircle, cls: 'border-line bg-surface text-ink-muted', label: 'Not sure' },
} as const

/** Everything about one key: verdict, where its door is (map + pictures), what is behind it. */
export function KeyDetails({ row, data, owned, onToggleOwned, onClose }: { row: KeyDetailsRow; data: GameData; owned: boolean; onToggleOwned: (v: boolean) => void; onClose: () => void }) {
  const wiki = useKeyWiki(row.item.wikiLink)
  const maps = useMemo(() => locksByMap(data, row.item.id), [data, row.item.id])
  const [mapIndex, setMapIndex] = useState(0)
  const spawnMaps = useMemo(() => keySpawnsByMap(data, row.item.id, (n) => findMapConfig(n)?.key), [data, row.item.id])
  const [spawnIndex, setSpawnIndex] = useState(0)
  const spawnShown = spawnMaps[Math.min(spawnIndex, spawnMaps.length - 1)]
  const spawnMarkers = useMemo<KeyMarker[]>(
    () => (spawnShown ? spawnShown.points.map((p, i) => ({ id: `s${i}`, position: p, kind: 'spawn', label: 'Key can spawn here' })) : []),
    [spawnShown],
  )
  const traderNames = useMemo(() => new Map(data.traders.map((t) => [t.id, t.name])), [data.traders])
  const [lightbox, setLightbox] = useState<number | null>(null)
  const allImages = useMemo(() => [...(wiki.data?.lockImages ?? []), ...(wiki.data?.keyImages ?? []), ...(wiki.data?.behindImages ?? [])], [wiki.data])
  const verdict = keyVerdict({ behind: wiki.data ? wiki.data.behind : wiki.isError ? [] : null, questNames: row.quests.map((q) => q.name) })
  const style = VERDICT_STYLE[wiki.isPending && verdict.kind !== 'quest' ? 'unknown' : verdict.kind]
  const shown = maps[Math.min(mapIndex, maps.length - 1)]

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && lightbox === null && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, lightbox])

  const openImage = (img: GuideImage) => setLightbox(allImages.findIndex((i) => i.full === img.full))

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-labelledby="key-title" onClick={(e) => e.stopPropagation()} className="my-6 w-full max-w-3xl rounded-lg border border-line bg-surface-2 shadow-xl">
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          {row.item.iconLink ? <img src={row.item.iconLink} alt="" className="h-10 w-10 object-contain" /> : <KeyRound className="h-8 w-8 text-ink-dim" />}
          <div className="min-w-0 flex-1">
            <h2 id="key-title" className="truncate text-base font-semibold">{row.item.name}</h2>
            <p className="text-xs text-ink-muted">
              Flea reference {formatRoubles(row.item.avg24hPrice)}
              {row.item.buyFromTrader[0] ? ` · trader quote ${formatRoubles(row.item.buyFromTrader[0].priceRUB)}` : ''}
            </p>
          </div>
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={owned} onChange={(e) => onToggleOwned(e.target.checked)} className="h-4 w-4" /> I have it
          </label>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-ink-dim hover:bg-surface-3 hover:text-ink">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-5 px-5 py-4">
          <section className={`rounded border px-3 py-2 ${style.cls}`}>
            <div className="flex items-center gap-2 font-semibold">
              <style.icon className="h-5 w-5" /> {style.label}
              {wiki.isPending && verdict.kind !== 'quest' && <Loader2 className="h-4 w-4 animate-spin" />}
            </div>
            <div className="mt-1 text-xs text-ink">
              {verdict.kind === 'quest' && (
                <p>
                  Needed for {row.quests.map((q) => q.name).join(', ')}.
                  {verdict.lootWorth != null && ` The room itself is ${verdict.lootWorth ? 'also worth looting' : 'not much worth it otherwise'}.`}
                </p>
              )}
              {verdict.reasons.length > 0 && <p className="text-ink-muted">Behind the lock: {verdict.reasons.join(', ')}.</p>}
              {verdict.kind === 'unknown' && !wiki.isPending && <p className="text-ink-muted">The wiki lists nothing behind this lock, so there is nothing to judge.</p>}
              <p className="mt-1 text-[11px] text-ink-dim">A rough estimate from the wiki's loot list; loot spawns are random.</p>
            </div>
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Where the lock is</h3>
            {maps.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {maps.map((m, i) => (
                  <button key={m.configKey} type="button" onClick={() => setMapIndex(i)} className={`rounded border px-2 py-0.5 text-xs ${i === mapIndex ? 'border-accent bg-accent/15 text-accent' : 'border-line text-ink-muted hover:text-ink'}`}>
                    {m.mapName}
                  </button>
                ))}
              </div>
            )}
            {shown ? (
              <>
                <KeyMap key={shown.configKey} normalizedName={shown.normalizedName} configKey={shown.configKey} markers={lockMarkers(shown.locks, row.item.name)} />
                <p className="text-xs text-ink-muted">
                  {shown.mapName}: {shown.locks.length} lock{shown.locks.length > 1 ? 's' : ''} for this key (from tarkov.dev's map data).
                </p>
              </>
            ) : (
              <p className="text-xs text-ink-dim">tarkov.dev's map data has no position for this lock{wiki.data?.lockText.length ? '; see the wiki description below' : ''}.</p>
            )}
            {wiki.data?.lockText.map((t) => <p key={t} className="text-sm">{t}</p>)}
            <Thumbs images={wiki.data?.lockImages ?? []} onOpen={openImage} />
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Where to find the key</h3>
            {spawnMaps.length > 1 && (
              <div className="flex flex-wrap gap-1">
                {spawnMaps.map((m, i) => (
                  <button key={m.configKey} type="button" onClick={() => setSpawnIndex(i)} className={`rounded border px-2 py-0.5 text-xs ${i === Math.min(spawnIndex, spawnMaps.length - 1) ? 'border-success bg-success/15 text-success' : 'border-line text-ink-muted hover:text-ink'}`}>
                    {m.mapName} ({m.points.length})
                  </button>
                ))}
              </div>
            )}
            {spawnShown ? (
              <>
                <KeyMap key={`spawn-${spawnShown.configKey}`} normalizedName={spawnShown.normalizedName} configKey={spawnShown.configKey} markers={spawnMarkers} />
                <p className="text-xs text-ink-muted">
                  {spawnShown.mapName}: {spawnShown.points.length} loose-loot spot{spawnShown.points.length > 1 ? 's' : ''} where this key can spawn (green). From the game's loot data via tarkov.dev; how likely each spot is, is not in the data.
                </p>
              </>
            ) : (
              <p className="text-xs text-ink-dim">tarkov.dev's loot data has no loose-loot spot for this key.</p>
            )}
            {wiki.data && wiki.data.keyText.length > 0 && (
              <div className="rounded border border-line bg-surface p-2">
                <p className="mb-1 text-[11px] text-ink-dim">The EFT Wiki says:</p>
                <WikiLines lines={wiki.data.keyText} />
              </div>
            )}
            <Thumbs images={wiki.data?.keyImages ?? []} onOpen={openImage} />
            {row.item.buyFromTrader.length > 0 && (
              <div className="text-sm">
                <p>
                  Catalog trader offers{' '}
                  {row.item.buyFromTrader
                    .map((b) => `· ${traderNames.get(b.traderId) ?? 'a trader'}${b.minTraderLevel ? ` (loyalty ${b.minTraderLevel})` : ''} for ${formatRoubles(b.priceRUB)}`)
                    .join(' ')}
                  .
                </p>
                <p className="mt-1 text-xs text-ink-dim">
                  These are reference quotes. Buying one also needs the loyalty level, offer unlock quest and remaining per-restock purchase limit for your character, which this list does not verify.
                </p>
              </div>
            )}
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Behind the lock</h3>
            {wiki.isPending && (
              <p className="flex items-center gap-2 text-xs text-ink-muted">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading from the EFT Wiki…
              </p>
            )}
            {wiki.isError && <p className="text-xs text-ink-dim">The wiki page for this key could not be loaded.</p>}
            {wiki.data && wiki.data.behind.length === 0 && <p className="text-xs text-ink-dim">The wiki does not say.</p>}
            {wiki.data && wiki.data.behind.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {wiki.data.behind.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            )}
            <Thumbs images={wiki.data?.behindImages ?? []} onOpen={openImage} />
          </section>

          {wiki.data && wiki.data.notes.length > 0 && (
            <section className="space-y-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Notes</h3>
              {wiki.data.notes.map((t) => (
                <p key={t} className="text-xs text-ink-muted">{t}</p>
              ))}
            </section>
          )}

          {(wiki.data?.pageUrl ?? row.item.wikiLink) && (
            <p className="text-[11px] text-ink-dim">
              Pictures and descriptions:{' '}
              <a href={wiki.data?.pageUrl ?? row.item.wikiLink ?? '#'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline hover:text-accent">
                EFT Wiki <ExternalLink className="h-3 w-3" />
              </a>{' '}
              (CC BY-SA 3.0). Lock positions: tarkov.dev.
            </p>
          )}
        </div>
      </div>
      {lightbox !== null && allImages[lightbox] && <Lightbox images={allImages} index={lightbox} onClose={() => setLightbox(null)} onIndex={setLightbox} />}
    </div>
  )
}

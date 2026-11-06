import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapContainer, useMap } from 'react-leaflet'
import { AlertTriangle, Loader2, Maximize2, Minimize2 } from 'lucide-react'
import { floorIsDrawable, type BaseLayerConfig, type FloorLayerConfig } from './mapConfig'
import { createMapCRS, gameBoundsToLatLngBounds } from './projection'
import { svgText } from './svgCache'
import { sanitizeSvg } from '../lib/sanitizeSvg'
import { usePack } from '../desktop/usePack'

/** Extra zoom beyond the native tiles, like tarkov.dev (max(7, maxZoom)). */
const OVERZOOM = 7
/**
 * 1x1 fully transparent GIF so tiles outside an image never show a broken-image
 * icon. (A previous PNG here was actually a half-opaque blue pixel, which drew
 * blue bands around map edges.)
 */
const BLANK_TILE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

type ImageryState = 'loading' | 'ready' | 'error'

/**
 * Loads a tarkov.dev map SVG once and returns a detached <svg> element whose
 * top-level <g id> groups are classified as base (ground) or overlay (floors).
 */
async function loadSvg(layer: BaseLayerConfig, signal: AbortSignal): Promise<SVGSVGElement> {
  const text = await svgText(layer.svgPath as string, signal)
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const inner = doc.documentElement
  if (inner.nodeName.toLowerCase() !== 'svg') throw new Error('Not an SVG document')
  // Remote file going into the live page: drawing elements only (see sanitizeSvg).
  sanitizeSvg(inner)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  const viewBox = inner.getAttribute('viewBox')
  if (viewBox) svg.setAttribute('viewBox', viewBox)
  while (inner.firstChild) svg.appendChild(inner.firstChild)
  for (const child of Array.from(svg.children)) {
    if (child.nodeName.toLowerCase() !== 'g' || !child.id) continue
    const g = child as SVGGElement
    const keepWith = g.dataset['keepWithGroup']
    if (g.id === layer.svgLayer || keepWith === layer.svgLayer) g.classList.add('tc-base-group')
    else g.classList.add('tc-overlay-group')
  }
  return svg
}

interface ImageryProps {
  layer: BaseLayerConfig
  floor: FloorLayerConfig | null
  onState: (state: ImageryState, message?: string) => void
}

/**
 * The pane for the SVG map drawing: above the tiles (200), below everything drawn on the map (400+).
 * In the overlay pane itself the drawing covered every canvas-drawn dot (containers, spawns, loot
 * spots), because Leaflet's CSS puts an <svg> (z-index 200) above the canvas (100) in a pane.
 */
function basePane(map: L.Map): string {
  if (!map.getPane('tcBase')) {
    const pane = map.createPane('tcBase')
    pane.style.zIndex = '250'
    pane.style.pointerEvents = 'none'
  }
  return 'tcBase'
}

/**
 * Imperative Leaflet layer management (tiles, SVG, floors). Lives inside
 * MapContainer so it can use the map instance. The MapContainer is keyed on the
 * base layer, so changing imagery remounts everything (the CRS can't change).
 */
function Imagery({ layer, floor, onState }: ImageryProps) {
  const map = useMap()
  const tileRef = useRef<L.TileLayer | null>(null)
  const svgOverlayRef = useRef<L.SVGOverlay | null>(null)
  const svgElRef = useRef<SVGSVGElement | null>(null)
  const floorTileRef = useRef<L.TileLayer | null>(null)
  const [svgReady, setSvgReady] = useState(false)

  const bounds = useMemo(() => gameBoundsToLatLngBounds(layer.bounds), [layer])
  const svgBounds = useMemo(
    () => (layer.svgBounds ? gameBoundsToLatLngBounds(layer.svgBounds) : bounds),
    [layer, bounds],
  )
  const useTiles = layer.kind === 'tiles'

  useEffect(() => {
    const controller = new AbortController()
    let tileErrors = 0
    let tileLoads = 0
    let settled = false
    let errorTimer: ReturnType<typeof setTimeout> | null = null
    const settle = (state: ImageryState, message?: string) => {
      if (settled) return
      settled = true
      onState(state, message)
    }
    onState('loading')

    if (useTiles && layer.tilePath) {
      const tile = L.tileLayer(layer.tilePath, {
        tileSize: layer.tileSize ?? 256,
        bounds,
        minZoom: layer.minZoom,
        maxZoom: Math.max(OVERZOOM, layer.maxZoom),
        maxNativeZoom: layer.maxZoom,
        noWrap: true,
        errorTileUrl: BLANK_TILE,
        className: 'tc-base-tiles',
      })
      // Edge tiles outside tarkov.dev's pyramid return 404 and often arrive before the
      // first real tile, so errors alone mean nothing. Only report a failure when no
      // tile at all has loaded a few seconds after the errors started, and clear it
      // as soon as any tile does load (e.g. after a network blip).
      let showingError = false
      tile.on('tileload', () => {
        tileLoads += 1
        if (showingError) {
          showingError = false
          onState('ready')
        }
        settle('ready')
      })
      tile.on('tileerror', () => {
        tileErrors += 1
        if (tileLoads > 0 || tileErrors !== 4) return
        errorTimer = setTimeout(() => {
          if (tileLoads > 0 || controller.signal.aborted) return
          showingError = true
          settled = true
          onState(
            'error',
            !/^https?:/i.test(layer.tilePath ?? '')
              ? 'The map tiles are missing. Generate them with "npm run tiles:lighthouse" (see README).'
              : 'The map tiles could not be downloaded from the imagery host. Check your internet connection.',
          )
        }, 4000)
      })
      tile.addTo(map)
      tileRef.current = tile
    }

    // The SVG is loaded whenever it exists: it is the base image for "svg"
    // layers and the source of floor plans for tile layers.
    if (layer.svgPath) {
      loadSvg(layer, controller.signal)
        .then((svg) => {
          svgElRef.current = svg
          svg.classList.toggle('tc-hide-base', useTiles)
          const overlay = L.svgOverlay(svg, svgBounds, { className: 'tc-svg-overlay', interactive: false, pane: basePane(map) })
          svgOverlayRef.current = overlay
          overlay.addTo(map)
          setSvgReady(true)
          if (!useTiles) settle('ready')
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted) return
          if (!useTiles) settle('error', `The map image could not be downloaded (${err instanceof Error ? err.message : 'error'}).`)
        })
    }

    map.fitBounds(bounds, { animate: false })

    return () => {
      controller.abort()
      if (errorTimer) clearTimeout(errorTimer)
      tileRef.current?.remove()
      tileRef.current = null
      svgOverlayRef.current?.remove()
      svgOverlayRef.current = null
      svgElRef.current = null
      setSvgReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layer, map])

  // Floor switching.
  useEffect(() => {
    floorTileRef.current?.remove()
    floorTileRef.current = null
    const svg = svgElRef.current
    const tile = tileRef.current

    if (svg) {
      for (const g of Array.from(svg.querySelectorAll<SVGGElement>(':scope > g.tc-overlay-group'))) {
        g.classList.toggle('tc-visible', Boolean(floor?.svgLayer) && g.id === floor?.svgLayer)
      }
      svg.classList.toggle('tc-off-level', Boolean(floor))
    }
    if (tile) tile.setOpacity(floor ? 0.25 : 1)

    if (floor?.tilePath) {
      const fl = L.tileLayer(floor.tilePath, {
        tileSize: layer.tileSize ?? 256,
        bounds,
        minZoom: layer.minZoom,
        maxZoom: Math.max(OVERZOOM, layer.maxZoom),
        maxNativeZoom: layer.maxZoom,
        noWrap: true,
        errorTileUrl: BLANK_TILE,
        className: 'tc-floor-tiles',
      })
      fl.addTo(map)
      floorTileRef.current = fl
    }
  }, [floor, layer, bounds, map, svgReady])

  return null
}

/** Re-fits the map whenever its box changes size (quest panel hidden/shown, window resized). */
function SizeWatcher() {
  const map = useMap()
  useEffect(() => {
    const el = map.getContainer()
    const ro = new ResizeObserver(() => map.invalidateSize({ pan: false }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [map])
  return null
}

function FullscreenButton({ target }: { target: React.RefObject<HTMLDivElement | null> }) {
  const map = useMap()
  const [active, setActive] = useState(false)
  useEffect(() => {
    const onChange = () => {
      setActive(document.fullscreenElement === target.current)
      setTimeout(() => map.invalidateSize(), 50)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [map, target])

  const toggle = () => {
    const el = target.current
    if (!el) return
    if (document.fullscreenElement === el) void document.exitFullscreen()
    else void el.requestFullscreen().catch(() => undefined)
  }

  return (
    <div className="leaflet-top leaflet-right">
      <div className="leaflet-control leaflet-bar">
        <a
          href="#fullscreen"
          role="button"
          title={active ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={active ? 'Exit fullscreen' : 'Fullscreen'}
          onClick={(e) => {
            e.preventDefault()
            toggle()
          }}
          className="!flex !h-[30px] !w-[30px] items-center justify-center"
        >
          {active ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </a>
      </div>
    </div>
  )
}

export interface MapViewerProps {
  /** Unique key for the map (remount when it changes). */
  mapKey: string
  layer: BaseLayerConfig
  /** Layer name of the active floor; null = ground. */
  floorName: string | null
  /** Override the layer's affine (used by the align tool to preview a fit). */
  affineOverride?: BaseLayerConfig['affine']
  children?: ReactNode
}

export function MapViewer({ mapKey, layer, floorName, affineOverride, children }: MapViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [state, setState] = useState<ImageryState>('loading')
  const [message, setMessage] = useState<string | undefined>()
  const effectiveLayer = useMemo(
    () => (affineOverride ? { ...layer, affine: affineOverride } : layer),
    [layer, affineOverride],
  )
  const crs = useMemo(() => createMapCRS(effectiveLayer), [effectiveLayer])
  const bounds = useMemo(() => gameBoundsToLatLngBounds(effectiveLayer.bounds), [effectiveLayer])
  const floor = useMemo(
    () => effectiveLayer.floors.find((l) => l.name === floorName && floorIsDrawable(l, effectiveLayer)) ?? null,
    [effectiveLayer, floorName],
  )
  const remountKey = `${mapKey}:${layer.id}:${(affineOverride ?? layer.affine).join(',')}`
  // Desktop: some images (Lighthouse) are a content pack downloaded the first time.
  const { state: pack, retry: retryPack } = usePack(layer.pack, layer.pack && layer.kind === 'svg' ? 'drawing' : undefined)

  if (pack.status === 'downloading') {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[#0a0a09] p-6">
        <div className="w-72 rounded border border-line bg-surface-2 p-4 text-sm">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
            {pack.installing ? 'Unpacking the map…' : `Downloading the ${pack.label || 'map'}…`}
          </div>
          <div className="mt-3 h-1.5 overflow-hidden rounded bg-surface-3">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${pack.percent}%` }} />
          </div>
          <p className="mt-2 text-xs text-ink-muted">Only needed once; after that it works offline.</p>
        </div>
      </div>
    )
  }

  return (
    // `isolate`: Leaflet's panes and controls use z-index 400–1000; keep them inside the map so
    // the app's dialogs (Settings, scanner, first-run, …) always sit above it.
    <div ref={containerRef} className="relative isolate h-full w-full bg-[#0a0a09]">
      <MapContainer
        key={remountKey}
        crs={crs}
        bounds={bounds}
        minZoom={effectiveLayer.minZoom}
        maxZoom={Math.max(OVERZOOM, effectiveLayer.maxZoom)}
        zoomSnap={0.25}
        zoomDelta={0.5}
        wheelPxPerZoomLevel={80}
        attributionControl={false}
        preferCanvas
        pmIgnore={false}
        className="h-full w-full !bg-[#0a0a09]"
      >
        <Imagery
          layer={effectiveLayer}
          floor={floor}
          onState={(s, m) => {
            setState(s)
            setMessage(m)
          }}
        />
        <FullscreenButton target={containerRef} />
        <SizeWatcher />
        {children}
      </MapContainer>

      {state === 'loading' && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[1000] flex justify-center">
          <span className="inline-flex items-center gap-2 rounded border border-line bg-surface-2/90 px-3 py-1.5 text-xs text-ink-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> Loading map imagery…
          </span>
        </div>
      )}
      {pack.status === 'error' && (
        <div className="absolute inset-x-0 top-3 z-[1000] flex justify-center px-4">
          <div role="alert" className="flex items-center gap-2 rounded border border-danger/50 bg-surface-2/95 px-3 py-2 text-xs text-ink">
            <AlertTriangle className="h-4 w-4 shrink-0 text-danger" />
            <span>The map picture could not be downloaded ({pack.message}). Markers still work. You can choose another map picture above.</span>
            <button type="button" onClick={retryPack} className="btn !py-0.5 text-xs">Retry</button>
          </div>
        </div>
      )}
      {state === 'error' && pack.status !== 'error' && (
        <div className="absolute inset-x-0 top-3 z-[1000] flex justify-center px-4">
          <div role="alert" className="flex items-start gap-2 rounded border border-danger/50 bg-surface-2/95 px-3 py-2 text-xs text-ink">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
            <span>{message ?? 'The map image is unavailable.'} Markers and drawings still work.</span>
          </div>
        </div>
      )}
    </div>
  )
}

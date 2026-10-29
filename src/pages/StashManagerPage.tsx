import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, ImageUp, Plus, Save, Trash2, Undo2 } from 'lucide-react'
import { useItems } from '../api/hooks'
import type { GameMode } from '../api/client'
import { useProgressStore } from '../store/progress'
import { MultiViewPanel } from '../inventory/MultiViewPanel'
import { ExportPanel } from '../inventory/ExportPanel'
import { PlanningPanel } from '../inventory/PlanningPanel'
import { BackupPanel } from '../inventory/BackupPanel'
import { StackIdentityReview } from '../inventory/StackIdentityReview'
import { ScreenshotRegistration, type StagedScreenshot } from '../inventory/ScreenshotRegistration'
import type { Grid } from '../scan/core'
import { checkedCrop, checkedGrid, type ImageCrop } from '../scan/registration'
import { registerCaptureDestination } from '../scan/captureDestination'
import { imageFromClipboard } from '../scan/scanStore'
import { canReadQuantity, quantityFitsCatalog, readStackQuantities, type QuantityReading, type QuantityReport } from '../scan/quantity'
import { subscribe } from '../desktop/adapters/tauriEvents'
import {
  archiveScreenshot,
  inventoryCall,
  nativeInventoryAvailable,
  type Container,
  type Inventory,
  type LocalProfile,
  type ScanDraft,
  type ScanSession,
  type Stack,
  type CommitResult,
  type Observation,
  readArchivedScreenshot,
} from '../inventory/client'

const inputClass =
  'rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink'
const unknown = (): Stack => ({
  id: crypto.randomUUID(),
  itemId: null,
  quantity: null,
  fir: 'unknown',
  location: { column: 0, row: 0, width: 1, height: 1, rotated: false },
  provenance: {
    identityConfirmed: false,
    quantityConfirmed: false,
    method: 'manual',
    screenshotHash: null,
    observationId: null,
    corrected: false,
  },
  neverSell: false,
})
const captureTime = () => new Date().toISOString()

interface ScanRegistration {
  sessionId: string
  width: number
  height: number
  crop: ImageCrop
  grid: Grid
  lastHash: string
}

export function StashManagerPage() {
  const mode = useProgressStore((s) => s.gameMode)
  return <StashManager key={mode} mode={mode} />
}

function StashManager({ mode }: { mode: GameMode }) {
  const catalog = useItems()
  const [profile, setProfile] = useState<LocalProfile | null>(null)
  const [profilesLoading, setProfilesLoading] = useState(true)
  const [inventory, setInventory] = useState<Inventory | null>(null)
  const [selectedId, setSelectedId] = useState('')
  const [session, setSession] = useState<ScanSession | null>(null)
  const [draft, setDraft] = useState<ScanDraft | null>(null)
  const [viewSize, setViewSize] = useState({ columns: 14, rows: 14 })
  const [lastCommit, setLastCommit] = useState<CommitResult | null>(null)
  const [containerName, setContainerName] = useState('')
  const [dimensions, setDimensions] = useState({ columns: 14, rows: 14 })
  const [query, setQuery] = useState('')
  const [reviewStackId, setReviewStackId] = useState<string | null>(null)
  const [stagedImage, setStagedImage] = useState<StagedScreenshot | null>(null)
  const [captureArmed, setCaptureArmed] = useState(false)
  const [registration, setRegistration] = useState<ScanRegistration | null>(null)
  const [assisted, setAssisted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const commitKey = useRef('')
  const actionBusy = useRef(false)
  const available = nativeInventoryAvailable()

  useEffect(() => {
    const token = ++generation.current
    let active = true
    if (!available) return
    void inventoryCall<LocalProfile[]>({ operation: 'listProfiles' })
      .then((profiles) => {
        if (active && generation.current === token)
          setProfile(profiles.find((p) => p.mode === mode) ?? null)
      })
      .catch(
        (e: unknown) =>
          active && generation.current === token && setError(String(e)),
      )
      .finally(() => {
        if (active) setProfilesLoading(false)
      })
    return () => {
      active = false
      generation.current = token + 1
    }
  }, [mode, available])

  useEffect(() => {
    if (!profile) return
    const token = generation.current
    let active = true
    const load = () => {
      void inventoryCall<Inventory>({
        operation: 'inventory',
        profileId: profile.id,
      })
        .then((value) => {
          if (active && generation.current === token) setInventory(value)
        })
        .catch(
          (e: unknown) =>
            active && generation.current === token && setError(String(e)),
        )
    }
    load()
    const stop = subscribe('inventory-changed', load)
    return () => {
      active = false
      stop()
    }
  }, [profile])

  const selected = inventory?.containers.find(
    (entry) => entry.container.id === selectedId,
  )
  const observationsById = useMemo(() => new Map(
    draft?.observations.map((observation) => [observation.id, observation]) ?? [],
  ), [draft?.observations])
  const totals = useMemo(() => {
    const map = new Map<
      string,
      { quantity: number; uncertain: number; locations: string[] }
    >()
    for (const entry of inventory?.containers ?? [])
      for (const stack of entry.snapshot?.stacks ?? []) {
        const id = stack.itemId ?? 'unknown'
        const row = map.get(id) ?? { quantity: 0, uncertain: 0, locations: [] }
        if (
          stack.quantity !== null &&
          stack.provenance.quantityConfirmed &&
          stack.provenance.identityConfirmed
        )
          row.quantity += stack.quantity
        else row.uncertain++
        if (!row.locations.includes(entry.container.name))
          row.locations.push(entry.container.name)
        map.set(id, row)
      }
    return [...map.entries()].sort(([a], [b]) =>
      (catalog.data?.items[a]?.name ?? a).localeCompare(
        catalog.data?.items[b]?.name ?? b,
      ),
    )
  }, [inventory, catalog.data])
  const candidates = useMemo(
    () =>
      query.trim().length < 2
        ? []
        : Object.values(catalog.data?.items ?? {})
            .filter((item) =>
              `${item.name} ${item.shortName}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .slice(0, 8),
    [query, catalog.data],
  )

  async function action<T>(work: () => Promise<T>): Promise<T | undefined> {
    if (actionBusy.current) return
    actionBusy.current = true
    const token = generation.current
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      return await work()
    } catch (e) {
      if (generation.current === token)
        setError(e instanceof Error ? e.message : String(e))
    } finally {
      actionBusy.current = false
      if (generation.current === token) setBusy(false)
    }
  }
  function receiveImage(image: Blob) {
    if (actionBusy.current) {
      setNotice('Screenshot skipped: a stash operation is still running. Finish it and import again; the current draft is unchanged.')
      return
    }
    void action(async () => {
      const next = await importImage(image)
      if (!next || !assisted || !registration || registration.sessionId !== session?.id) return
      if (registration.lastHash === next.hash) {
        setNotice('This screenshot was already prepared. Existing draft rows are unchanged.')
        return
      }
      try {
        if (next.width !== registration.width || next.height !== registration.height
          || viewSize.columns !== registration.grid.cols || viewSize.rows !== registration.grid.rows)
          throw new Error('Screenshot or visible grid dimensions changed. Select the container again. Draft rows are unchanged.')
        const result = await recognizeImage(registration.crop, undefined, next, registration.grid)
        if (result) setRegistration({ ...registration, lastHash: next.hash })
      } catch (cause) {
        setAssisted(false)
        setRegistration(null)
        throw cause
      }
    })
  }
  async function refresh(profileId = profile?.id) {
    if (profileId) {
      const token = generation.current
      const value = await inventoryCall<Inventory>({
        operation: 'inventory',
        profileId,
      })
      if (token === generation.current) setInventory(value)
    }
  }
  function changeDraft(next: ScanDraft) {
    commitKey.current = crypto.randomUUID()
    setDraft({ ...next, reviewConfirmed: false })
  }
  function updateStack(id: string, patch: Partial<Stack>) {
    if (draft)
      changeDraft({
        ...draft,
        stacks: draft.stacks.map((stack) => {
          if (stack.id !== id) return stack
          const moved = patch.location &&
            (Object.keys(patch.location) as (keyof Stack['location'])[])
              .some((field) => patch.location?.[field] !== stack.location[field])
          const next = { ...stack, ...patch }
          if (moved) next.joinedSources = undefined
          if (moved || ('itemId' in patch && patch.itemId !== stack.itemId)) {
            next.dogtag = undefined
            next.durability = undefined
          } else if (patch.provenance && !patch.provenance.identityConfirmed) {
            if (next.dogtag) next.dogtag = { ...next.dogtag, confirmed: false }
            if (next.durability) next.durability = { ...next.durability, confirmed: false }
          }
          if (moved) {
            // Different source pixels need new, independent review facts.
            next.provenance = {
              ...next.provenance,
              identityConfirmed: false,
              quantityConfirmed: false,
              corrected: true,
            }
            next.fir = 'unknown'
          }
          return next
        }),
      })
  }
  async function begin(container: Container, scope: 'full' | 'partial' = 'full') {
    setRegistration(null)
    setAssisted(false)
    setReviewStackId(null)
    setStagedImage(null)
    setCaptureArmed(false)
    if (session?.status === 'draft')
      await inventoryCall({ operation: 'abandonScan', sessionId: session.id })
    const next = await inventoryCall<ScanSession>({
      operation: 'beginScan',
      containerId: container.id,
      scope,
    })
    setViewSize({ columns: container.columns, rows: container.rows })
    setSession(next)
    setSelectedId(container.id)
    setLastCommit(null)
    setDraft({
      fullCoverageConfirmed: false,
      reviewConfirmed: false,
      capturedAt: captureTime(),
      algorithmVersion: 'manual-v1',
      catalogVersion: catalog.dataUpdatedAt
        ? String(catalog.dataUpdatedAt)
        : 'unknown',
      stacks: [],
      observations: [],
    })
    commitKey.current = crypto.randomUUID()
  }
  async function resume(container: Container) {
    setRegistration(null)
    setAssisted(false)
    setReviewStackId(null)
    setStagedImage(null)
    setCaptureArmed(false)
    const scans = await inventoryCall<ScanSession[]>({
      operation: 'listScans',
      containerId: container.id,
    })
    const saved = scans.find(
      (scan) =>
        scan.status === 'draft' &&
        scan.baseRevision === container.revision &&
        scan.draft,
    )
    if (!saved?.draft)
      throw new Error('No saved draft matches the current container revision.')
    setSelectedId(container.id)
    setSession(saved)
    setViewSize({ columns: saved.draft.observations[0]?.sourceGrid?.cols ?? container.columns, rows: saved.draft.observations[0]?.sourceGrid?.rows ?? container.rows })
    setDraft(saved.draft)
    setLastCommit(null)
    commitKey.current = crypto.randomUUID()
  }
  async function importImage(file: Blob) {
    if (!session || !draft) return
    const token = generation.current
    const hash = await archiveScreenshot(file)
    if (generation.current !== token) return
    const bitmap = await createImageBitmap(file)
    const { width, height } = bitmap
    bitmap.close()
    checkedCrop(null, { width, height })
    if (generation.current !== token) return
    const next = { blob: file, hash, width, height }
    setStagedImage(next)
    setNotice('Screenshot archived. Select one complete container before recognizing it. Existing draft rows are unchanged.')
    return next
  }
  async function retryQuantity(stack: Stack): Promise<QuantityReading | undefined> {
    const observation = observationsById.get(stack.provenance.observationId ?? '')
    if (!draft || !stack.itemId || !stack.provenance.identityConfirmed || !observation?.sourceGrid)
      throw new Error('Confirm the item identity and register its screenshot grid before reading the amount.')
    const token = generation.current
    const footprint = {
      col: stack.location.column, row: stack.location.row,
      w: stack.location.width, h: stack.location.height,
      itemId: stack.itemId, rotated: stack.location.rotated, error: 0, alternatives: [],
    }
    if (!canReadQuantity(catalog.data?.items[stack.itemId], footprint))
      throw new Error('Quantity OCR requires a known stackable item and its complete catalog footprint. Enter the amount manually.')
    const file = await readArchivedScreenshot(observation.screenshotHash)
    if (generation.current !== token) return
    const result = await readStackQuantities(file, observation.sourceGrid, [footprint],
      catalog.data?.items ?? {}, () => generation.current === token)
    if (generation.current !== token) return
    const reading = result.readings.get(0)
    if (!reading) throw new Error('This quantity region is outside the image or OCR resource limits. Check the footprint or enter the amount manually.')
    if (draft.observations.length >= 65_536)
      throw new Error('This draft has reached its evidence limit. Save it and start a new scan before reading more quantities.')
    const next: Observation = {
      ...observation, id: crypto.randomUUID(), location: stack.location,
      quantity: reading.quantity, quantityEvidence: reading.evidence, reviewed: false,
    }
    changeDraft({
      ...draft,
      observations: [...draft.observations, next],
      stacks: draft.stacks.map((entry) => entry.id === stack.id ? {
        ...entry, quantity: reading.quantity,
        provenance: { ...entry.provenance, quantityConfirmed: false, observationId: next.id },
      } : entry),
    })
    return reading
  }
  async function recognizeImage(crop: ImageCrop, grid?: Grid, image = stagedImage, expectedGrid?: Grid): Promise<Grid | undefined> {
    if (!session || !draft || !image || !selected) return
    const token = generation.current
    const { blob: file, hash } = image
    const [
      { readWords },
      { scanImage },
      { learnedFingerprints, useLearnedStore },
    ] = await Promise.all([
      import('../scan/ocr'),
      import('../scan/scanner'),
      import('../scan/learned'),
    ])
    await useLearnedStore.getState().load()
    if (generation.current !== token) return
    let ocrFailed = false
    const words = await readWords(file, crop, { isCurrent: () => generation.current === token }).catch(() => {
      ocrFailed = true
      return undefined
    })
    if (generation.current !== token) return
    const result = await scanImage(
      file,
      crop,
      undefined,
      learnedFingerprints(useLearnedStore.getState().records),
      undefined,
      words,
      undefined,
      grid,
      expectedGrid,
    )
    if (generation.current !== token) return
    if (result.grid.cols !== viewSize.columns || result.grid.rows !== viewSize.rows)
      throw new Error(`Detected ${result.grid.cols}×${result.grid.rows} cells; this visible view is ${viewSize.columns}×${viewSize.rows}. Adjust the selected area or set the grid manually. Draft rows are unchanged.`)
    checkedGrid(result.grid, crop)
    let quantities: QuantityReport | undefined
    let quantityFailure = ''
    try {
      quantities = await readStackQuantities(file, result.grid, result.detections,
        catalog.data?.items ?? {}, () => generation.current === token)
    } catch (cause) {
      if (generation.current !== token) return
      quantityFailure = cause instanceof Error ? cause.message : String(cause)
    }
    if (generation.current !== token) return
    setReviewStackId(null)
    const observations = result.detections.map((det, index) => ({
      id: crypto.randomUUID(),
      screenshotHash: hash,
      location: {
        column: det.col,
        row: det.row,
        width: det.w,
        height: det.h,
        rotated: det.rotated,
      },
      candidates: [
        { itemId: det.itemId, error: det.error },
        ...det.alternatives,
      ],
      quantity: quantities?.readings.get(index)?.quantity ?? null,
      quantityEvidence: quantities?.readings.get(index)?.evidence,
      fir: 'unknown' as const,
      reviewed: false,
      sourceGrid: result.grid,
    }))
    changeDraft({
      ...draft,
      fullCoverageConfirmed: false,
      reviewConfirmed: false,
      capturedAt: captureTime(),
      algorithmVersion: `${ocrFailed ? 'rgb12-image-only-v1' : 'rgb12-ocr-v1'}+quantity-v1`,
      catalogVersion: catalog.dataUpdatedAt ? String(catalog.dataUpdatedAt) : 'unknown',
      observations,
      stacks: observations.map((observation) => ({
        ...unknown(),
        itemId: observation.candidates[0]?.itemId ?? null,
        quantity: observation.quantity,
        location: observation.location,
        provenance: {
          identityConfirmed: false,
          quantityConfirmed: false,
          method: 'screenshot',
          screenshotHash: hash,
          observationId: observation.id,
          corrected: false,
        },
      })),
    })
    const quantitySummary = quantityFailure
      ? `Quantity OCR failed: ${quantityFailure}. Amounts remain unknown. `
      : quantities?.eligible
        ? `Quantity OCR: ${quantities.suggested} suggested, ${quantities.attempted - quantities.suggested} unread/ambiguous and ${quantities.skipped} skipped by geometry/resource limits (${quantities.eligible} eligible stacks). All amounts require confirmation. `
        : 'No eligible stackable footprints; amounts remain unknown. '
    setNotice(`${result.assetWarnings?.join(' ') ?? ''} ${ocrFailed ? 'Name OCR was unavailable; image matching was used. ' : ''}${quantitySummary}Review each identity and amount. FIR remains unknown until confirmed. Verify the entire container before saving.`)
    if (!expectedGrid) {
      setRegistration({ sessionId: session.id, width: image.width, height: image.height,
        crop: { ...crop }, grid: { ...result.grid }, lastHash: hash })
      setAssisted(false)
    }
    return result.grid
  }

  // Install the current draft closure after each render; cleanup releases it on
  // navigation/profile changes. No image or target is retained by the router.
  useEffect(() => {
    if (!available || !captureArmed || !session || !draft) return
    return registerCaptureDestination((image) => receiveImage(image))
  })

  if (!available)
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold">Stash Manager</h1>
        <p className="text-ink-muted">
          Persistent containers and scan sessions use the native Rust build.
          Start it with <code>npm run dev:tauri</code>. Item Collection remains
          available in this build.
        </p>
      </div>
    )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <Boxes className="h-6 w-6" /> Stash Manager
        </h1>
        <p className="mt-1 text-sm text-ink-muted">
          {mode === 'pve' ? 'PvE' : 'PvP'} · Saved containers, individual stacks
          and confirmed full-container scans.
        </p>
      </div>
      {error && (
        <p
          role="alert"
          className="rounded border border-danger/50 bg-danger/10 p-3 text-sm text-danger"
        >
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-ink-muted">
          {notice}
        </p>
      )}
      {profile && <ExportPanel key={profile.id} profile={profile} busy={busy} run={(job) => action(job)} />}
      {!profile ? (
        <div className="space-y-3">
          <p className="text-ink-muted">
            Create a local inventory profile for this game mode. Quest progress
            remains in your existing profile.
          </p>
          <button
            disabled={busy || profilesLoading}
            className="btn"
            onClick={() =>
              void action(async () => {
                const value = await inventoryCall<LocalProfile>({
                  operation: 'createProfile',
                  mode,
                  name: mode === 'pve' ? 'PvE stash' : 'PvP stash',
                })
                setProfile(value)
              })
            }
          >
            {profilesLoading
              ? 'Loading inventory profile…'
              : 'Create inventory profile'}
          </button>
        </div>
      ) : (
        <>
          <section className="space-y-3" aria-labelledby="containers-title">
            <h2 id="containers-title" className="text-lg font-semibold">
              Containers
            </h2>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-xs text-ink-muted">
                Name
                <input
                  className={inputClass}
                  value={containerName}
                  onChange={(e) => setContainerName(e.target.value)}
                  placeholder="Junk box 1"
                />
              </label>
              <label className="grid gap-1 text-xs text-ink-muted">
                Columns
                <input
                  type="number"
                  min={1}
                  max={256}
                  className={`${inputClass} w-20`}
                  value={dimensions.columns}
                  onChange={(e) =>
                    setDimensions({
                      ...dimensions,
                      columns: e.target.valueAsNumber,
                    })
                  }
                />
              </label>
              <label className="grid gap-1 text-xs text-ink-muted">
                Rows
                <input
                  type="number"
                  min={1}
                  max={256}
                  className={`${inputClass} w-20`}
                  value={dimensions.rows}
                  onChange={(e) =>
                    setDimensions({
                      ...dimensions,
                      rows: e.target.valueAsNumber,
                    })
                  }
                />
              </label>
              <button
                disabled={busy || !containerName.trim()}
                className="btn"
                onClick={() =>
                  void action(async () => {
                    await inventoryCall({
                      operation: 'createContainer',
                      profileId: profile.id,
                      name: containerName.trim(),
                      kind: 'custom',
                      ...dimensions,
                    })
                    setContainerName('')
                    await refresh()
                  })
                }
              >
                <Plus className="h-4 w-4" /> Add container
              </button>
            </div>
            <p className="text-xs text-ink-dim">
              Set dimensions from the actual container grid; the initial values
              are editable.
            </p>
            <div className="divide-y divide-line border-y border-line">
              {inventory?.containers.map((entry) => (
                <div
                  key={entry.container.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div>
                    <strong>{entry.container.name}</strong>
                    <span className="ml-3 text-xs text-ink-muted">
                      {entry.container.columns}×{entry.container.rows} ·
                      revision {entry.container.revision} ·{' '}
                      {entry.snapshot
                        ? `${entry.snapshot.stacks.length} stacks · ${entry.snapshot.capturedAt}`
                        : 'Not scanned'}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn"
                      disabled={busy || !!draft}
                      onClick={() => void action(() => resume(entry.container))}
                    >
                      Resume saved draft
                    </button>
                    <button
                      className="btn"
                      disabled={busy || !!draft}
                      onClick={() => void action(() => begin(entry.container))}
                    >
                      New full scan
                    </button><button className="btn" disabled={busy || !entry.snapshot} onClick={() => void action(() => begin(entry.container, 'partial'))}>Update visible region</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
          {draft && session && selected && (
            <fieldset
              disabled={busy}
              className="space-y-3"
              aria-labelledby="review-title"
              onPaste={(event) => {
                const image = imageFromClipboard(event.nativeEvent)
                if (!image) return
                event.preventDefault()
                receiveImage(image)
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('Files')) event.preventDefault()
              }}
              onDrop={(event) => {
                const file = event.dataTransfer.files[0]
                if (!file) return
                event.preventDefault()
                receiveImage(file)
              }}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="review-title" className="text-lg font-semibold">
                  Review {selected.container.name}
                </h2>
                <label className="btn cursor-pointer">
                  <ImageUp className="h-4 w-4" /> Import screenshot
                  <input
                    disabled={busy}
                    type="file"
                    accept="image/png,image/jpeg,image/bmp,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) receiveImage(file)
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
              <label className="flex gap-2 text-sm">
                <input type="checkbox" checked={captureArmed} disabled={busy}
                  onChange={(event) => setCaptureArmed(event.target.checked)} />
                Send capture hotkey screenshots to {selected.container.name}
              </label>
              <p className="text-xs text-ink-muted">
                {captureArmed ? 'Capture destination armed for this draft. ' : ''}
                This applies while this page is open and the Item Collection scanner is closed.
                You can also paste or drop a screenshot here. Review the area and recognized rows before saving.
              </p>
              <label className="flex gap-2 text-sm">
                <input type="checkbox" checked={assisted}
                  disabled={busy || !registration || registration.sessionId !== session.id}
                  onChange={(event) => setAssisted(event.target.checked)} />
                I checked the last recognized area. Use it to prepare the next screenshots automatically.
              </label>
              <p className="max-w-prose text-xs text-ink-muted">
                First recognize a selected area manually, then enable this for the current session.
                Keep the same container open in the same position. New images replace current editor rows
                with unconfirmed suggestions; save any source view you want to keep first.
                A changed grid requires manual selection. Nothing is saved to inventory automatically.
              </p>
              {registration && registration.sessionId === session.id && <p className="text-xs text-ink-muted">
                Last recognized area: X {registration.crop.x}, Y {registration.crop.y},
                width {registration.crop.w}, height {registration.crop.h};
                grid {registration.grid.cols}×{registration.grid.rows}.
              </p>}
              <p className="text-sm text-ink-muted">
                A confirmed full scan replaces this container only. Empty or
                unrecognized regions must be checked in the game. Reimporting
                this session never adds to the previous snapshot.
              </p>
              <div className="flex flex-wrap gap-3">
                {(['columns', 'rows'] as const).map((key) => <label key={key} className="text-sm">Visible {key} <input className={`${inputClass} w-20`} type="number" min={1} max={selected.container[key]} value={viewSize[key]} disabled={busy} onChange={(e) => { const value = Number(e.target.value); if (Number.isInteger(value) && value >= 1 && value <= selected.container[key]) { setRegistration(null); setAssisted(false); setViewSize({ ...viewSize, [key]: value }); changeDraft({ ...draft, fullCoverageConfirmed: false, reviewConfirmed: false }) } }} /></label>)}
              </div>
              {stagedImage && (
                <ScreenshotRegistration
                  key={`${stagedImage.hash}:${viewSize.columns}:${viewSize.rows}`}
                  image={stagedImage}
                  columns={viewSize.columns}
                  rows={viewSize.rows}
                  busy={busy}
                  hasDraftRows={draft.stacks.length > 0}
                  onScan={(crop, grid) => action(() => recognizeImage(crop, grid))}
                  onDismiss={() => setStagedImage(null)}
                />
              )}
              <div className="flex flex-wrap gap-2">
                <input
                  className={`${inputClass} min-w-64`}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find an item to add manually"
                  aria-label="Find item"
                />
                {candidates.map((item) => (
                  <button
                    disabled={busy}
                    key={item.id}
                    className="btn text-xs"
                    onClick={() => {
                      changeDraft({
                        ...draft,
                        stacks: [
                          ...draft.stacks,
                          {
                            ...unknown(),
                            itemId: item.id,
                            location: {
                              ...unknown().location,
                              width: item.width,
                              height: item.height,
                            },
                          },
                        ],
                      })
                      setQuery('')
                    }}
                  >
                    {item.shortName}
                  </button>
                ))}
                <button
                  disabled={busy}
                  className="btn"
                  onClick={() =>
                    changeDraft({
                      ...draft,
                      stacks: [...draft.stacks, unknown()],
                    })
                  }
                >
                  Add unknown region
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-ink-muted">
                    <tr>
                      <th className="py-2">Item</th>
                      <th>Amount</th>
                      <th>FIR</th>
                      <th>Column / row</th>
                      <th>Width / height</th>
                      <th>Confirmed</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {draft.stacks.map((stack) => (
                      <Fragment key={stack.id}>
                      <tr>
                        <td className="py-3 pr-3">
                          <span>
                            {catalog.data?.items[stack.itemId ?? '']?.name ??
                              stack.itemId ??
                              'Unknown item'}
                          </span>
                          <button
                            className="mt-1 block text-xs text-accent underline underline-offset-2"
                            aria-expanded={reviewStackId === stack.id}
                            onClick={() => setReviewStackId(reviewStackId === stack.id ? null : stack.id)}
                          >
                            {reviewStackId === stack.id ? 'Hide item review' : 'Review or correct item'}
                          </button>
                          <label className="mt-1 flex gap-1 text-xs text-ink-muted">
                            <input
                              type="checkbox"
                              checked={stack.neverSell}
                              onChange={(e) =>
                                updateStack(stack.id, {
                                  neverSell: e.target.checked,
                                })
                              }
                            />{' '}
                            Never sell
                          </label>
                        </td>
                        <td>
                          <input
                            type="number"
                            min={1}
                            max={catalog.data?.items[stack.itemId ?? '']?.stackMaxSize ?? 0xffff_ffff}
                            step={1}
                            aria-label="Stack quantity"
                            className={`${inputClass} w-20`}
                            value={stack.quantity ?? ''}
                            placeholder="?"
                            onChange={(e) =>
                              updateStack(stack.id, {
                                quantity:
                                  Number.isSafeInteger(
                                    e.target.valueAsNumber,
                                  ) && e.target.valueAsNumber > 0
                                    ? e.target.valueAsNumber
                                    : null,
                                provenance: {
                                  ...stack.provenance,
                                  quantityConfirmed: false,
                                },
                              })
                            }
                          />
                          {!stack.provenance.quantityConfirmed
                            && observationsById.get(stack.provenance.observationId ?? '')?.quantityEvidence?.status === 'candidate'
                            && observationsById.get(stack.provenance.observationId ?? '')?.quantityEvidence?.itemId === stack.itemId
                            && observationsById.get(stack.provenance.observationId ?? '')?.quantity === stack.quantity && (
                            <p className="text-xs text-ink-muted">OCR suggestion · confirm amount</p>
                          )}
                          {stack.quantity !== null && !quantityFitsCatalog(stack.quantity, catalog.data?.items[stack.itemId ?? '']) && (
                            <p className="max-w-40 text-xs text-danger">Above the catalog stack limit. Check the amount or identity.</p>
                          )}
                        </td>
                        <td>
                          <select
                            aria-label="Found in raid"
                            className={inputClass}
                            value={stack.fir}
                            onChange={(e) =>
                              updateStack(stack.id, {
                                fir: e.target.value as Stack['fir'],
                              })
                            }
                          >
                            <option value="unknown">Unknown</option>
                            <option value="yes">Yes</option>
                            <option value="no">No</option>
                          </select>
                        </td>
                        <td>
                          {(['column', 'row'] as const).map((field) => (
                            <input
                              key={field}
                              type="number"
                              min={0}
                              aria-label={field}
                              className={`${inputClass} mr-1 w-16`}
                              value={stack.location[field]}
                              onChange={(e) =>
                                updateStack(stack.id, {
                                  location: {
                                    ...stack.location,
                                    [field]: e.target.valueAsNumber,
                                  },
                                })
                              }
                            />
                          ))}
                        </td>
                        <td>
                          {(['width', 'height'] as const).map((field) => (
                            <input
                              key={field}
                              type="number"
                              min={1}
                              aria-label={field}
                              className={`${inputClass} mr-1 w-16`}
                              value={stack.location[field]}
                              onChange={(e) =>
                                updateStack(stack.id, {
                                  location: {
                                    ...stack.location,
                                    [field]: e.target.valueAsNumber,
                                  },
                                })
                              }
                            />
                          ))}
                        </td>
                        <td>
                          <label className="flex gap-1 text-xs">
                            <input
                              type="checkbox"
                              disabled={!stack.itemId}
                              checked={stack.provenance.identityConfirmed}
                              onChange={(e) =>
                                updateStack(stack.id, {
                                  provenance: {
                                    ...stack.provenance,
                                    identityConfirmed: e.target.checked,
                                  },
                                })
                              }
                            />{' '}
                            Identity
                          </label>
                          <label className="flex gap-1 text-xs">
                            <input
                              type="checkbox"
                              disabled={stack.quantity === null || (!stack.provenance.quantityConfirmed && !quantityFitsCatalog(stack.quantity, catalog.data?.items[stack.itemId ?? '']))}
                              checked={stack.provenance.quantityConfirmed}
                              onChange={(e) =>
                                updateStack(stack.id, {
                                  provenance: {
                                    ...stack.provenance,
                                    quantityConfirmed: e.target.checked,
                                  },
                                })
                              }
                            />{' '}
                            Amount
                          </label>
                        </td>
                        <td>
                          <button
                            className="btn"
                            aria-label="Remove stack"
                            onClick={() =>
                              changeDraft({
                                ...draft,
                                stacks: draft.stacks.filter(
                                  (s) => s.id !== stack.id,
                                ),
                              })
                            }
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                      {reviewStackId === stack.id && (
                        <tr>
                          <td colSpan={7}>
                            <StackIdentityReview
                              stack={stack}
                              observation={observationsById.get(stack.provenance.observationId ?? '')}
                              items={catalog.data?.items}
                              onReadQuantity={() => action(() => retryQuantity(stack))}
                              onChange={(patch) => updateStack(stack.id, patch)}
                              onClose={() => setReviewStackId(null)}
                            />
                          </td>
                        </tr>
                      )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.fullCoverageConfirmed}
                  onChange={(e) =>
                    changeDraft({
                      ...draft,
                      fullCoverageConfirmed: e.target.checked,
                    })
                  }
                />{' '}
                I checked the entire container, including empty and unrecognized
                regions.
              </label>
              <label className="flex gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.reviewConfirmed}
                  onChange={(e) =>
                    setDraft({ ...draft, reviewConfirmed: e.target.checked })
                  }
                />{' '}
                Save these reviewed facts; unknown values remain uncertain.
              </label>
              <MultiViewPanel key={session.id} session={session} container={selected.container} draft={draft} imageHash={stagedImage?.hash} viewSize={viewSize} busy={busy} validDraft={(value) => !value.stacks.some((stack) => stack.provenance.quantityConfirmed && !quantityFitsCatalog(stack.quantity, catalog.data?.items[stack.itemId ?? '']))} run={(job) => action(job)}
                onEdit={async (view) => { const token = generation.current; const blob = await readArchivedScreenshot(view.screenshotHash); const bitmap = await createImageBitmap(blob); const { width, height } = bitmap; bitmap.close(); if (generation.current !== token) return; setRegistration(null); setAssisted(false); setViewSize({ columns: view.columns, rows: view.rows }); setStagedImage({ blob, hash: view.screenshotHash, width, height }); changeDraft(structuredClone(view.draft)); setReviewStackId(null) }}
                onApply={(next) => { setRegistration(null); setAssisted(false); setViewSize({ columns: selected.container.columns, rows: selected.container.rows }); changeDraft(next) }}
                onCommitted={async (result) => { setLastCommit(result); setSession(null); setDraft(null); setStagedImage(null); await refresh() }} />
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await inventoryCall({
                        operation: 'saveDraft',
                        sessionId: session.id,
                        draft,
                      })
                      setNotice('Draft saved. Accepted inventory is unchanged.')
                    })
                  }
                >
                  Save draft
                </button>
                <button
                  className="btn"
                  disabled={
                    busy ||
                    session.scope !== 'full' || viewSize.columns !== selected.container.columns || viewSize.rows !== selected.container.rows ||
                    !draft.fullCoverageConfirmed ||
                    !draft.reviewConfirmed ||
                    draft.stacks.some((stack) => stack.provenance.quantityConfirmed && !quantityFitsCatalog(stack.quantity, catalog.data?.items[stack.itemId ?? '']))
                  }
                  onClick={() =>
                    void action(async () => {
                      await inventoryCall({
                        operation: 'saveDraft',
                        sessionId: session.id,
                        draft,
                      })
                      const result = await inventoryCall<CommitResult>({
                        operation: 'commitScan',
                        request: {
                          sessionId: session.id,
                          expectedRevision: session.baseRevision,
                          idempotencyKey: commitKey.current,
                        },
                      })
                      setLastCommit(result)
                      setSession(null)
                      setDraft(null)
                      setStagedImage(null)
                      setCaptureArmed(false)
                      await refresh()
                      setNotice('Container snapshot saved atomically.')
                    })
                  }
                >
                  <Save className="h-4 w-4" /> Replace container snapshot
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() =>
                    void action(async () => {
                      await inventoryCall({
                        operation: 'abandonScan',
                        sessionId: session.id,
                      })
                      setDraft(null)
                      setSession(null)
                      setStagedImage(null)
                      setCaptureArmed(false)
                    })
                  }
                >
                  Discard draft
                </button>
              </div>
            </fieldset>
          )}
          {lastCommit && (
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await inventoryCall({
                    operation: 'undoCommit',
                    containerId: lastCommit.containerId,
                    snapshotId: lastCommit.snapshotId,
                    expectedRevision: lastCommit.revision,
                  })
                  setLastCommit(null)
                  await refresh()
                })
              }
            >
              <Undo2 className="h-4 w-4" /> Undo last container commit
            </button>
          )}
          <section className="space-y-3" aria-labelledby="combined-title">
            <h2 id="combined-title" className="text-lg font-semibold">
              Combined inventory
            </h2>
            <p className="text-sm text-ink-muted">
              Confirmed quantities stay separate from uncertain stacks. Sale
              recommendations require the allocation planner and complete
              requirements.
            </p>
            <div className="divide-y divide-line border-y border-line">
              {totals.map(([itemId, row]) => (
                <div
                  key={itemId}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  <span>{catalog.data?.items[itemId]?.name ?? itemId}</span>
                  <span className="text-sm text-ink-muted">
                    {row.quantity} confirmed
                    {row.uncertain
                      ? ` · ${row.uncertain} uncertain stacks`
                      : ''}{' '}
                    · {row.locations.join(', ')} · REVIEW
                  </span>
                </div>
              ))}
              {!totals.length && (
                <p className="py-4 text-sm text-ink-dim">
                  Add a container and save its first reviewed scan.
                </p>
              )}
            </div>
          </section>
          {inventory && <PlanningPanel inventory={inventory} />}
        </>
      )}
      <BackupPanel />
    </div>
  )
}

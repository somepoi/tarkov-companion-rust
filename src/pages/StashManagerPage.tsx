import { useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, ImageUp, Plus, Save, Trash2, Undo2 } from 'lucide-react'
import { useItems } from '../api/hooks'
import type { GameMode } from '../api/client'
import { useProgressStore } from '../store/progress'
import { PlanningPanel } from '../inventory/PlanningPanel'
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
  const [lastCommit, setLastCommit] = useState<CommitResult | null>(null)
  const [containerName, setContainerName] = useState('')
  const [dimensions, setDimensions] = useState({ columns: 14, rows: 14 })
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const generation = useRef(0)
  const commitKey = useRef('')
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

  async function action(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    setNotice('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
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
        stacks: draft.stacks.map((stack) =>
          stack.id === id ? { ...stack, ...patch } : stack,
        ),
      })
  }
  async function begin(container: Container) {
    if (session?.status === 'draft')
      await inventoryCall({ operation: 'abandonScan', sessionId: session.id })
    const next = await inventoryCall<ScanSession>({
      operation: 'beginScan',
      containerId: container.id,
      scope: 'full',
    })
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
    setDraft(saved.draft)
    setLastCommit(null)
    commitKey.current = crypto.randomUUID()
  }
  async function importImage(file: File) {
    if (!session || !draft) return
    const token = generation.current
    const hash = await archiveScreenshot(file)
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
    const words = await readWords(file, null).catch(() => undefined)
    const result = await scanImage(
      file,
      null,
      undefined,
      learnedFingerprints(useLearnedStore.getState().records),
      undefined,
      words,
    )
    if (generation.current !== token) return
    const observations = result.detections.map((det) => ({
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
      quantity: null,
      fir: 'unknown' as const,
      reviewed: false,
    }))
    changeDraft({
      ...draft,
      capturedAt: captureTime(),
      algorithmVersion: 'rgb12-ocr-v1',
      observations,
      stacks: observations.map((observation) => ({
        ...unknown(),
        itemId: observation.candidates[0]?.itemId ?? null,
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
    setNotice(
      'Screenshot archived. Review each identity and amount. FIR remains unknown until confirmed. Crop to a single complete container before importing.',
    )
  }

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
                    </button>
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
                      if (file) void action(() => importImage(file))
                      e.target.value = ''
                    }}
                  />
                </label>
              </div>
              <p className="text-sm text-ink-muted">
                A confirmed full scan replaces this container only. Empty or
                unrecognized regions must be checked in the game. Reimporting
                this session never adds to the previous snapshot.
              </p>
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
                      <tr key={stack.id}>
                        <td className="py-3 pr-3">
                          <span>
                            {catalog.data?.items[stack.itemId ?? '']?.name ??
                              stack.itemId ??
                              'Unknown item'}
                          </span>
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
                              disabled={stack.quantity === null}
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
                    !draft.fullCoverageConfirmed ||
                    !draft.reviewConfirmed
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
    </div>
  )
}

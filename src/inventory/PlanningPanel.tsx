import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useGameData, useHideout, useItems } from '../api/hooks'
import { contentMs } from '../api/queryClient'
import { useWikiQuests } from '../hooks/useWikiQuests'
import { useProgressStore } from '../store/progress'
import { useInventoryStore } from '../store/inventory'
import { subscribe } from '../desktop/adapters/tauriEvents'
import {
  inventoryCall,
  type Inventory,
  type PlanningPreferences,
  type PlanningState,
  type RecommendationPlan,
  type UserReserve,
} from './client'
import { fetchRecipeCatalog } from './recipeCatalog'
import { buildRequirements } from './requirements'
import { PlanResults } from './PlanResults'

const inputClass =
  'rounded border border-line bg-surface px-2 py-1.5 text-sm text-ink'
const quantity = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
const planningKey = (id: string) => ['stashPlanning', id] as const

export function PlanningPanel({ inventory }: { inventory: Inventory }) {
  const client = useQueryClient()
  const saved = useQuery({
    queryKey: planningKey(inventory.profile.id),
    queryFn: () =>
      inventoryCall<PlanningState>({
        operation: 'planningState',
        profileId: inventory.profile.id,
      }),
  })
  useEffect(
    () =>
      subscribe('inventory-changed', () => {
        void client.invalidateQueries({
          queryKey: planningKey(inventory.profile.id),
        })
      }),
    [client, inventory.profile.id],
  )
  if (saved.isPending)
    return (
      <p role="status" className="text-sm text-ink-muted">
        Loading saved plans and reserves…
      </p>
    )
  if (saved.isError)
    return (
      <p role="alert" className="text-sm text-danger">
        {saved.error.message}{' '}
        <button className="btn" onClick={() => void saved.refetch()}>
          Retry
        </button>
      </p>
    )
  return (
    <PlannerEditor
      key={inventory.profile.id}
      inventory={inventory}
      saved={saved.data}
    />
  )
}

function PlannerEditor({
  inventory,
  saved,
}: {
  inventory: Inventory
  saved: PlanningState
}) {
  const client = useQueryClient()
  const mode = inventory.profile.mode
  const progression = useProgressStore((s) => s.profiles[mode])
  const stationLevels = useInventoryStore((s) => s.byMode[mode].stationLevels)
  const items = useItems()
  const game = useGameData()
  const hideout = useHideout()
  const wiki = useWikiQuests(false)
  const recipes = useQuery({
    queryKey: ['planningRecipes', mode],
    queryFn: ({ signal }) => fetchRecipeCatalog(mode, signal),
    staleTime: contentMs(),
  })
  const [base, setBase] = useState(saved)
  const [preferences, setPreferences] = useState<PlanningPreferences>(
    saved.preferences,
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [epoch, setEpoch] = useState(0)
  const [confirmed, setConfirmed] = useState('')
  const [calculated, setCalculated] = useState<{
    signature: string
    plan: RecommendationPlan
  } | null>(null)
  const [itemSearch, setItemSearch] = useState('')
  const [recipeSearch, setRecipeSearch] = useState('')
  const [recipeKind, setRecipeKind] = useState<'crafts' | 'barters'>('crafts')
  const [recipeId, setRecipeId] = useState('')
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    const invalidate = () => {
      setConfirmed('')
      setEpoch((n) => n + 1)
    }
    const stop = subscribe('inventory-changed', invalidate)
    const stopWipe = subscribe('wipe-detected', invalidate)
    window.addEventListener('blur', invalidate)
    return () => {
      stop()
      stopWipe()
      window.removeEventListener('blur', invalidate)
    }
  }, [])
  const normalized = useMemo(
    () =>
      buildRequirements({
        tasks: [
          ...(game.data?.tasks ?? []),
          ...wiki.tasks.filter(
            (t) => t.wiki?.kind !== 'arena' && t.wiki?.kind !== 'past',
          ),
        ],
        profile: progression,
        stations: hideout.data ?? [],
        stationLevels,
        preferences,
        recipes: recipes.data,
        items: items.data?.items ?? {},
      }),
    [
      game.data,
      wiki.tasks,
      progression,
      hideout.data,
      stationLevels,
      preferences,
      recipes.data,
      items.data,
    ],
  )
  const catalogVersion = `${mode}:items@${items.dataUpdatedAt}:quests@${game.dataUpdatedAt}:hideout@${hideout.dataUpdatedAt}:recipes@${recipes.dataUpdatedAt}`
  const progressionRevision = JSON.stringify([
    progression.playerLevel,
    progression.faction,
    [...progression.completedTaskIds].sort(),
    stationLevels,
  ])
  const revisions = Object.fromEntries(
    inventory.containers.map((e) => [e.container.id, e.container.revision]),
  )
  const inventorySignature = JSON.stringify([revisions, progressionRevision])
  const dirty = JSON.stringify(preferences) !== JSON.stringify(base.preferences)
  const conflict = base.revision !== saved.revision
  const signature = JSON.stringify([
    catalogVersion,
    progressionRevision,
    normalized,
    revisions,
    base.revision,
    preferences,
    epoch,
    confirmed,
    dirty,
    conflict,
    game.isError,
    hideout.isError,
    items.isError,
    recipes.isError,
    wiki.loading,
    Boolean(wiki.error),
  ])
  const plan =
    !expired && calculated?.signature === signature ? calculated.plan : null
  useEffect(() => {
    if (!calculated?.plan.saleDecisionsComplete) return
    const timestamps = [
      items.dataUpdatedAt,
      game.dataUpdatedAt,
      hideout.dataUpdatedAt,
    ]
    if (
      Object.values(preferences.craftBatches).some(Boolean) ||
      Object.values(preferences.barterBatches).some(Boolean)
    )
      timestamps.push(recipes.dataUpdatedAt)
    // One expiry deadline while advice is visible; no idle polling loop.
    const delay = Math.max(
      0,
      Math.min(...timestamps) + contentMs() - Date.now(),
    )
    const timer = setTimeout(() => setExpired(true), delay)
    return () => clearTimeout(timer)
  }, [
    calculated,
    items.dataUpdatedAt,
    game.dataUpdatedAt,
    hideout.dataUpdatedAt,
    recipes.dataUpdatedAt,
    preferences.craftBatches,
    preferences.barterBatches,
  ])

  const itemMatches = useMemo(
    () =>
      itemSearch.trim().length < 2
        ? []
        : Object.values(items.data?.items ?? {})
            .filter((i) =>
              `${i.name} ${i.shortName}`
                .toLowerCase()
                .includes(itemSearch.toLowerCase()),
            )
            .slice(0, 10),
    [items.data, itemSearch],
  )
  const recipeMatches = (recipes.data?.[recipeKind] ?? [])
    .filter((r) =>
      `${items.data?.items[r.outputId]?.name ?? r.outputId} ${r.id}`
        .toLowerCase()
        .includes(recipeSearch.toLowerCase()),
    )
    .slice(0, 30)

  async function act(work: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  function reserve(id: string, patch: Partial<UserReserve>) {
    setPreferences((p) => ({
      ...p,
      reserves: {
        ...p.reserves,
        [id]: {
          ...(p.reserves[id] ?? {
            extraBuffer: 0,
            minimumTotal: 0,
            neverSell: false,
          }),
          ...patch,
        },
      },
    }))
  }
  async function calculate() {
    const gaps = [...normalized.coverageGaps]
    if (
      !game.data ||
      game.isError ||
      !hideout.data ||
      hideout.isError ||
      !items.data ||
      items.isError
    )
      gaps.push('Quest, hideout or item catalog is unavailable')
    if (wiki.loading || wiki.error)
      gaps.push('Wiki-only quest coverage is unavailable or incomplete')
    const timestamps = [
      items.dataUpdatedAt,
      game.dataUpdatedAt,
      hideout.dataUpdatedAt,
    ]
    const selectedRecipes =
      Object.values(preferences.craftBatches).some(Boolean) ||
      Object.values(preferences.barterBatches).some(Boolean)
    if (selectedRecipes) {
      timestamps.push(recipes.dataUpdatedAt)
      if (!recipes.data || recipes.isError)
        gaps.push('Selected craft/barter catalog is unavailable')
    }
    if (timestamps.some((time) => !time || Date.now() - time > contentMs()))
      gaps.push(
        'Requirement catalog is stale; refresh before relying on surplus',
      )
    if (Object.keys(preferences.reserves).some((id) => !items.data?.items[id]))
      gaps.push('A reserved item is missing from the catalog')
    const result = await inventoryCall<RecommendationPlan>({
      operation: 'calculatePlan',
      request: {
        profileId: inventory.profile.id,
        expectedPlanRevision: base.revision,
        expectedContainerRevisions: revisions,
        catalogVersion,
        progressionRevision: Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              'SHA-256',
              new TextEncoder().encode(progressionRevision),
            ),
          ),
          (n) => n.toString(16).padStart(2, '0'),
        ).join(''),
        inventoryConfirmedCurrent: confirmed === inventorySignature,
        requirementsComplete: gaps.length === 0,
        coverageGaps: [...new Set(gaps)],
        requirements: normalized.requirements,
      },
    })
    setExpired(false)
    setCalculated({ signature, plan: result })
  }

  return (
    <section
      className="space-y-4 border-t border-line pt-5"
      aria-labelledby="planning-title"
    >
      <div>
        <h2 id="planning-title" className="text-lg font-semibold">
          Needs and reserves
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          All unfinished faction quests, target hideout upgrades and selected
          recipe batches. Existing quest completions and built hideout levels
          are reused. Checklist totals are separate from physical stock.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {conflict && (
        <p role="alert" className="text-sm text-warning">
          Saved planning preferences changed.{' '}
          <button
            className="btn"
            onClick={() => {
              setBase(saved)
              setPreferences(saved.preferences)
            }}
          >
            Reload saved preferences
          </button>{' '}
          (replaces unsaved edits)
        </p>
      )}
      <fieldset disabled={busy || conflict} className="space-y-4">
        <details className="border-b border-line pb-3">
          <summary className="cursor-pointer text-sm font-medium">
            Hideout targets
          </summary>
          <p className="my-2 text-xs text-ink-muted">
            Default: all known levels. Required dependencies are included
            automatically. Current levels are edited on the Hideout page.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {(hideout.data ?? []).map((station) => (
              <label
                key={station.id}
                className="flex items-center justify-between gap-2 text-sm"
              >
                <span>
                  {station.name}{' '}
                  <span className="text-xs text-ink-dim">
                    built {stationLevels[station.id] ?? 0}
                  </span>
                </span>
                <select
                  className={inputClass}
                  value={preferences.hideoutTargets[station.id] ?? 'all'}
                  onChange={(e) =>
                    setPreferences((p) => {
                      const targets = { ...p.hideoutTargets }
                      if (e.target.value === 'all') delete targets[station.id]
                      else targets[station.id] = Number(e.target.value)
                      return { ...p, hideoutTargets: targets }
                    })
                  }
                >
                  <option value="all">All levels</option>
                  <option value={0}>No upgrades</option>
                  {station.levels.map((l) => (
                    <option key={l.id} value={l.level}>
                      Level {l.level}
                      {(normalized.effectiveHideoutTargets[station.id] ?? 0) >
                      l.level
                        ? ' + dependencies'
                        : ''}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </details>
        <details className="border-b border-line pb-3">
          <summary className="cursor-pointer text-sm font-medium">
            Craft and barter batches
          </summary>
          <p className="my-2 text-xs text-ink-muted">
            Batches consume their ingredients. Returned tools are shared across
            sequential crafts and reserved at the largest simultaneous quantity.
            This does not guarantee trader access or availability.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Recipe type"
              className={inputClass}
              value={recipeKind}
              onChange={(e) => {
                setRecipeKind(e.target.value as typeof recipeKind)
                setRecipeId('')
              }}
            >
              <option value="crafts">Craft</option>
              <option value="barters">Barter</option>
            </select>
            <input
              aria-label="Find recipe output"
              className={inputClass}
              placeholder="Find output item…"
              value={recipeSearch}
              onChange={(e) => {
                setRecipeSearch(e.target.value)
                setRecipeId('')
              }}
            />
            <select
              aria-label="Recipe"
              className={`${inputClass} max-w-full sm:max-w-80`}
              value={recipeId}
              onChange={(e) => setRecipeId(e.target.value)}
            >
              <option value="">
                Choose recipe ({recipeMatches.length} shown)
              </option>
              {recipeMatches.map((r) => (
                <option key={r.id} value={r.id}>
                  {items.data?.items[r.outputId]?.name ?? r.outputId} ·{' '}
                  {r.id.slice(-6)}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={!recipeId}
              onClick={() =>
                setPreferences((p) => {
                  const key =
                    recipeKind === 'crafts' ? 'craftBatches' : 'barterBatches'
                  return {
                    ...p,
                    [key]: {
                      ...p[key],
                      [recipeId]: (p[key][recipeId] ?? 0) + 1,
                    },
                  }
                })
              }
            >
              Add batch
            </button>
          </div>
          {recipes.isError && (
            <p className="mt-2 text-sm text-warning">
              Recipe catalog unavailable: {recipes.error.message}
            </p>
          )}
          {(['craftBatches', 'barterBatches'] as const).map((key) => (
            <div key={key} className="mt-2 space-y-2">
              {Object.entries(preferences[key]).map(([id, batches]) => {
                const recipe = recipes.data?.[
                  key === 'craftBatches' ? 'crafts' : 'barters'
                ].find((r) => r.id === id)
                return (
                  <div
                    key={id}
                    className="flex flex-wrap items-center gap-2 text-sm"
                  >
                    <span className="min-w-0 flex-1 break-words">
                      {key === 'craftBatches' ? 'Craft' : 'Barter'}:{' '}
                      {recipe
                        ? (items.data?.items[recipe.outputId]?.name ??
                          recipe.outputId)
                        : id}
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={1_000_000}
                      step={1}
                      aria-label={`Batches ${id}`}
                      className={`${inputClass} w-24`}
                      value={batches}
                      onChange={(e) => {
                        const n = e.target.valueAsNumber
                        if (quantity(n))
                          setPreferences((p) => ({
                            ...p,
                            [key]: { ...p[key], [id]: n },
                          }))
                      }}
                    />
                    <button
                      className="btn"
                      onClick={() =>
                        setPreferences((p) => {
                          const next = { ...p[key] }
                          delete next[id]
                          return { ...p, [key]: next }
                        })
                      }
                    >
                      Remove
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
        </details>
        <details className="border-b border-line pb-3">
          <summary className="cursor-pointer text-sm font-medium">
            Personal reserves and never-sell
          </summary>
          <p className="my-2 text-xs text-ink-muted">
            Minimum total overlaps stock already kept for requirements. Extra
            buffer adds to consumptive requirements. Never-sell protects every
            copy of an item.
          </p>
          <input
            aria-label="Find item for reserve"
            className={inputClass}
            placeholder="Find item…"
            value={itemSearch}
            onChange={(e) => setItemSearch(e.target.value)}
          />
          <div className="mt-2 flex flex-wrap gap-2">
            {itemMatches.map((item) => (
              <button
                key={item.id}
                className="btn text-xs"
                onClick={() => reserve(item.id, {})}
              >
                Add {item.shortName || item.name}
              </button>
            ))}
          </div>
          <div className="mt-3 space-y-3">
            {Object.entries(preferences.reserves).map(([id, rule]) => (
              <div key={id} className="flex flex-wrap items-end gap-3 text-sm">
                <span className="min-w-40 flex-1 break-words">
                  {items.data?.items[id]?.name ?? id}
                </span>
                {(['minimumTotal', 'extraBuffer'] as const).map((field) => (
                  <label
                    key={field}
                    className="grid gap-1 text-xs text-ink-muted"
                  >
                    {field === 'minimumTotal'
                      ? 'Minimum total'
                      : 'Extra buffer'}
                    <input
                      className={`${inputClass} w-24`}
                      type="number"
                      min={0}
                      max={1_000_000}
                      step={1}
                      value={rule[field]}
                      onChange={(e) => {
                        const n = e.target.valueAsNumber
                        if (quantity(n)) reserve(id, { [field]: n })
                      }}
                    />
                  </label>
                ))}
                <label className="flex items-center gap-2 py-2">
                  <input
                    type="checkbox"
                    checked={rule.neverSell}
                    onChange={(e) =>
                      reserve(id, { neverSell: e.target.checked })
                    }
                  />
                  Never sell
                </label>
                <button
                  className="btn"
                  onClick={() =>
                    setPreferences((p) => {
                      const next = { ...p.reserves }
                      delete next[id]
                      return { ...p, reserves: next }
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className="btn"
            disabled={!dirty}
            onClick={() =>
              void act(async () => {
                const next = await inventoryCall<PlanningState>({
                  operation: 'savePlanningState',
                  profileId: inventory.profile.id,
                  expectedRevision: base.revision,
                  preferences,
                })
                setBase(next)
                setPreferences(next.preferences)
                client.setQueryData(planningKey(inventory.profile.id), next)
              })
            }
          >
            {busy ? 'Working…' : 'Save planning preferences'}
          </button>
          <span className="text-xs text-ink-muted">
            {dirty
              ? 'Unsaved changes — save before calculating'
              : `Saved revision ${base.revision}`}
          </span>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={confirmed === inventorySignature}
            onChange={(e) =>
              setConfirmed(e.target.checked ? inventorySignature : '')
            }
          />
          I checked that all saved container contents are current, including
          transfers and items consumed since scanning. Leaving this window
          clears this confirmation.
        </label>
        <button
          className="btn"
          disabled={dirty || !inventory.containers.length}
          onClick={() => void act(calculate)}
        >
          {busy ? 'Working…' : 'Calculate KEEP / SELL / REVIEW'}
        </button>
      </fieldset>
      {!plan && calculated && (
        <p role="status" className="text-sm text-warning">
          Advice is out of date. Recalculate after reviewing the current
          inventory, catalog and preferences.
        </p>
      )}
      {plan && (
        <PlanResults
          plan={plan}
          inventory={inventory}
          items={items.data?.items ?? {}}
        />
      )}
    </section>
  )
}

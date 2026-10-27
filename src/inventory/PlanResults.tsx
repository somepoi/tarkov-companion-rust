import { useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ItemsById } from '../api/types'
import type { Inventory, RecommendationPlan } from './client'

export function PlanResults({
  plan,
  inventory,
  items,
}: {
  plan: RecommendationPlan
  inventory: Inventory
  items: ItemsById
}) {
  'use no memo' // The virtualizer owns mutable measurement state.
  const [filter, setFilter] = useState('')
  const [verdict, setVerdict] = useState('all')
  const parent = useRef<HTMLDivElement>(null)
  const allocationsByStack = useMemo(() => {
    const map = new Map<string, RecommendationPlan['allocations']>()
    for (const allocation of plan.allocations) {
      const key = `${allocation.snapshotId}:${allocation.stackId}`
      const group = map.get(key) ?? []
      group.push(allocation)
      map.set(key, group)
    }
    return map
  }, [plan])
  const names = new Map(
    inventory.containers.map((e) => [e.container.id, e.container.name]),
  )
  const rows = useMemo(
    () =>
      plan.stacks.filter(
        (stack) =>
          (items[stack.itemId ?? '']?.name ?? stack.itemId ?? 'Unknown item')
            .toLowerCase()
            .includes(filter.toLowerCase()) &&
          (verdict === 'all' ||
            stack.portions.some((p) => p.recommendation === verdict)),
      ),
    [plan, items, filter, verdict],
  )
  // oxlint-disable-next-line react/incompatible-library -- Measurements stay local to this non-memoized component.
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 112,
    overscan: 5,
  })
  const totals = plan.items.reduce(
    (sum, item) => ({
      keep: sum.keep + item.keep,
      sell: sum.sell + item.sell,
      review: sum.review + item.reviewKnownQuantity,
      unknown: sum.unknown + item.unknownStacks,
    }),
    {
      keep: 0,
      sell: 0,
      review: 0,
      unknown: plan.stacks.filter((s) => !s.itemId).length,
    },
  )
  return (
    <div className="space-y-3" aria-label="Inventory recommendations">
      <p className="text-sm">
        KEEP {totals.keep} · SELL {totals.sell} · REVIEW {totals.review} known
        units · {totals.unknown} uncertain stacks
      </p>
      <p className="text-xs text-ink-muted">
        {plan.horizon}. Requirements consume full objective quantities; partial
        hand-ins are not inferred. No automatic sale or inventory changes.
      </p>
      {!!plan.coverageGaps.length && (
        <details open className="border-l-2 border-warning pl-3">
          <summary className="cursor-pointer text-sm font-medium text-warning">
            SELL blocked: {plan.coverageGaps.length} coverage or evidence gaps
          </summary>
          <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-xs text-ink-muted">
            {plan.coverageGaps.map((gap, i) => (
              <li key={i}>{gap}</li>
            ))}
          </ul>
        </details>
      )}
      {!!plan.unfulfilled.length && (
        <details>
          <summary className="cursor-pointer text-sm">
            {plan.unfulfilled.length} unmet requirements
          </summary>
          <ul className="mt-2 max-h-48 space-y-2 overflow-auto text-xs text-ink-muted">
            {plan.unfulfilled.map((r, i) => (
              <li key={i}>
                {r.quantity ?? '?'} ×{' '}
                {r.alternatives
                  .map((id) => items[id]?.name ?? id)
                  .join(' / ') || 'unknown item'}{' '}
                · {r.reason} · {r.requirementIds.join(', ')}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          className="rounded border border-line bg-surface px-2 py-1.5 text-sm"
          aria-label="Filter recommendations"
          placeholder="Filter items…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <select
          className="rounded border border-line bg-surface px-2 py-1.5 text-sm"
          aria-label="Recommendation"
          value={verdict}
          onChange={(e) => setVerdict(e.target.value)}
        >
          <option value="all">All recommendations</option>
          {['KEEP', 'SELL', 'REVIEW'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span className="self-center text-xs text-ink-dim">
          {rows.length} physical stacks
        </span>
      </div>
      <div
        ref={parent}
        className="max-h-[36rem] overflow-auto border-y border-line"
        style={{ height: Math.min(576, Math.max(112, rows.length * 112)) }}
      >
        <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
          {virtual.getVirtualItems().map((row) => {
            const stack = rows[row.index]
            const allocations =
              allocationsByStack.get(`${stack.snapshotId}:${stack.stackId}`) ??
              []
            return (
              <div
                key={`${stack.snapshotId}:${stack.stackId}`}
                ref={virtual.measureElement}
                data-index={row.index}
                className="absolute left-0 top-0 w-full border-b border-line py-3 pr-2"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <p className="text-sm font-medium">
                  {items[stack.itemId ?? '']?.name ??
                    stack.itemId ??
                    'Unknown item'}{' '}
                  <span className="font-normal text-ink-muted">
                    · {names.get(stack.containerId) ?? stack.containerId} · cell{' '}
                    {stack.location.column}, {stack.location.row}
                  </span>
                </p>
                {stack.portions.map((p, i) => (
                  <p key={i} className="mt-1 text-xs text-ink-muted">
                    <strong
                      className={
                        p.recommendation === 'SELL'
                          ? 'text-info'
                          : p.recommendation === 'REVIEW'
                            ? 'text-warning'
                            : 'text-ink'
                      }
                    >
                      {p.recommendation} {p.quantity ?? '?'}
                    </strong>{' '}
                    · {p.reason}
                  </p>
                ))}
                {!!allocations.length && (
                  <details className="mt-2 text-xs">
                    <summary className="cursor-pointer text-ink-muted">
                      Why this stock is kept ({allocations.length} allocations)
                    </summary>
                    <ul className="mt-2 space-y-1 text-ink-dim">
                      {allocations.map((a, i) => (
                        <li key={i}>
                          {a.quantity} × {a.reason} ·{' '}
                          {a.requirementIds.join(', ')}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )
          })}
        </div>
        {!rows.length && (
          <p className="p-4 text-sm text-ink-muted">
            No physical stacks match these filters.
          </p>
        )}
      </div>
      <p className="break-words text-xs text-ink-dim">
        Plan revision {plan.planRevision} · catalog {plan.catalogVersion} ·
        source snapshots {Object.values(plan.containerRevisions).join(', ')}
      </p>
    </div>
  )
}

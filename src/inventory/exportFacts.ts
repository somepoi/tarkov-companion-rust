import type { Inventory } from './client'

const LIMIT = 20 * 1024 * 1024
const headers = ['record_type', 'profile_id', 'mode', 'container_id', 'container_name', 'container_columns', 'container_rows', 'snapshot_id', 'revision', 'full_coverage', 'captured_at', 'stack_id', 'item_id', 'quantity', 'fir', 'column', 'row', 'width', 'height', 'rotated', 'identity_confirmed', 'quantity_confirmed', 'never_sell', 'method', 'screenshot_hash', 'observation_id', 'dogtag_level', 'dogtag_level_confirmed', 'durability_percent', 'durability_confirmed', 'joined_sources']
/** CSV is a spreadsheet-facing report; JSON retains exact source text. */
function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value)
  if (typeof value === 'string' && (/^[=+\-@]/.test(text.trimStart()) || /^[\t\r\n]/.test(text))) text = "'" + text
  return '"' + text.replaceAll('"', '""') + '"'
}
export function inventoryExport(inventory: Inventory, format: 'json' | 'csv', exportedAt: string): Blob {
  let result: Blob
  if (format === 'json') {
    result = new Blob([JSON.stringify({ format: 'tarkov-companion-inventory-facts', version: 1, exportedAt, appVersion: import.meta.env.VITE_APP_VERSION,
      scope: 'Saved physical inventory and separately labeled legacy counts; excludes drafts, screenshots, recommendations and recovery state.', inventory }, null, 2)], { type: 'application/json;charset=utf-8' })
  } else {
    const lines = [headers.map(csvCell).join(',') + '\r\n']
    let bytes = 3 + new TextEncoder().encode(lines[0]).length
    const append = (values: unknown[]) => {
      const line = values.map(csvCell).join(',') + '\r\n'
      bytes += new TextEncoder().encode(line).length
      if (bytes > LIMIT) throw new Error('Inventory CSV exceeds 20 MiB; use a full backup for larger data')
      lines.push(line)
    }
    for (const entry of inventory.containers) {
      const { container, snapshot } = entry
      const base = [inventory.profile.id, inventory.profile.mode, container.id, container.name, container.columns, container.rows,
        snapshot?.id ?? '', container.revision, snapshot?.fullCoverageConfirmed ?? 'unscanned', snapshot?.capturedAt ?? '']
      append(['container', ...base, ...Array(headers.length - base.length - 1).fill('')])
      for (const stack of snapshot?.stacks ?? []) append(['physical-stack', ...base, stack.id, stack.itemId, stack.quantity, stack.fir,
        stack.location.column, stack.location.row, stack.location.width, stack.location.height, stack.location.rotated,
        stack.provenance.identityConfirmed, stack.provenance.quantityConfirmed, stack.neverSell, stack.provenance.method,
        stack.provenance.screenshotHash, stack.provenance.observationId, stack.dogtag?.level, stack.dogtag?.confirmed ?? false,
        stack.durability?.percent, stack.durability?.confirmed ?? false,
        stack.joinedSources?.length ? JSON.stringify(stack.joinedSources) : ''])
    }
    for (const [item, count] of Object.entries(inventory.legacy?.counts ?? {})) append(['legacy-count', inventory.profile.id, inventory.profile.mode, '', '', '', '', '', '', 'unlocated', '', '', item, count, 'unknown', '', '', '', '', '', false, false, '', 'legacy-checklist', '', '', '', false, '', false, ''])
    result = new Blob(['\uFEFF', ...lines], { type: 'text/csv;charset=utf-8' })
  }
  if (result.size > LIMIT) throw new Error('Inventory export exceeds 20 MiB; use a full backup for larger data')
  return result
}

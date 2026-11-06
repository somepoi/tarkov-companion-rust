import { useState } from 'react'
import { Key } from 'lucide-react'
import type { ItemsById } from '../../api/types'
import { formatRoubles } from '../../lib/format'

/**
 * "🔑 Key name" badge. Click to reveal the key's icon and flea price. Several
 * ids = alternatives ("or"). Works without items loaded (shows "Key required").
 */
export function KeyBadge({
  keyIds,
  items,
  compact = false,
}: {
  keyIds: string[]
  items: ItemsById | undefined
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  if (keyIds.length === 0) return null
  const keys = keyIds.map((id) => items?.[id] ?? null)
  const label = items
    ? keys.map((k, i) => k?.shortName ?? k?.name ?? `key ${keyIds[i].slice(-4)}`).join(' or ')
    : 'Key required'
  const fullNames = items ? keys.map((k) => k?.name ?? '').join(' or ') : 'Loading key names…'

  return (
    <span className="relative inline-block align-middle">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
        title={fullNames}
        className={`inline-flex items-center gap-1 rounded border border-accent/50 bg-accent/10 text-accent hover:bg-accent/20 ${compact ? 'px-1 py-0 text-[10px]' : 'px-1.5 py-0.5 text-[11px]'}`}
      >
        <Key className="h-3 w-3" aria-hidden />
        <span className="max-w-[160px] truncate">{label}</span>
      </button>
      {open && (
        <span
          role="dialog"
          className="absolute left-0 top-full z-[1100] mt-1 w-56 rounded border border-line bg-surface-2 p-2 text-left text-xs text-ink shadow-xl"
          onClick={(e) => e.stopPropagation()}
        >
          {keys.map((k, i) => (
            <span key={keyIds[i]} className="flex items-center gap-2 py-1">
              {k?.iconLink ? (
                <img src={k.iconLink} alt="" className="h-8 w-8 rounded-sm object-contain" />
              ) : (
                <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-surface-3">
                  <Key className="h-4 w-4 text-ink-dim" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{k?.name ?? (items ? 'Unknown key' : 'Loading…')}</span>
                <span className="block text-ink-muted">
                  Flea ref {formatRoubles(k?.avg24hPrice)}
                  {k?.lastLowPrice != null ? ` · low ${formatRoubles(k.lastLowPrice)}` : ''}
                </span>
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

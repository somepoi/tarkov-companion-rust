import type { BaseLayerConfig, MapConfig } from './mapConfig'

function Link({ href, children }: { href?: string; children: React.ReactNode }) {
  if (!href) return <>{children}</>
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-ink-muted underline hover:text-accent">
      {children}
    </a>
  )
}

/** Footer crediting every imagery source the current map can show. */
export function MapCredits({
  cfg,
  mapName,
  activeLayer,
}: {
  cfg: MapConfig
  mapName: string
  activeLayer: BaseLayerConfig
}) {
  // One line per distinct source (tarkov.dev, RE3MR, ...), active layer first.
  const seen = new Set<string>()
  const credits: BaseLayerConfig['credit'][] = []
  for (const l of [activeLayer, ...cfg.baseLayers]) {
    const key = `${l.credit.name}|${l.credit.author ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    credits.push(l.credit)
  }

  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-surface-2 px-3 py-1.5 text-[11px] text-ink-dim md:px-4">
      {credits.map((c, i) => (
        <span key={i}>
          {c.name === 'tarkov.dev' ? (
            <>
              Map data and coordinates from <Link href={c.link}>tarkov.dev</Link>
              {c.license ? ` (${c.license})` : ''}
              {c.author ? (
                <>
                  , {mapName} drawing by <Link href={c.authorLink}>{c.author}</Link>
                </>
              ) : null}
              .
            </>
          ) : (
            <>
              {mapName} {c.what ?? 'render'} by <Link href={c.link}>{c.name}</Link>
              {c.link ? ` (${c.link.replace(/^https?:\/\//, '')})` : ''}
              {c.license ? `, ${c.license}` : ''}.
            </>
          )}
        </span>
      ))}
      <span className="ml-auto">Scroll to zoom · drag to pan</span>
    </footer>
  )
}

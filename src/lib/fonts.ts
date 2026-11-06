/**
 * Fonts the app can use (Settings → Appearance), all of them fonts Windows already has: nothing is
 * downloaded or bundled. Each falls back to the next in its list, then to the system font.
 */
export type FontChoice = 'system' | 'bahnschrift' | 'arial' | 'verdana' | 'tahoma' | 'trebuchet' | 'calibri' | 'georgia' | 'consolas'

const SYSTEM = '"Segoe UI", system-ui, -apple-system, sans-serif'

export const FONTS: { id: FontChoice; label: string; note: string; stack: string }[] = [
  { id: 'system', label: 'Segoe UI', note: 'Windows default', stack: SYSTEM },
  { id: 'bahnschrift', label: 'Bahnschrift', note: 'Narrow, military look', stack: `Bahnschrift, "DIN Alternate", ${SYSTEM}` },
  { id: 'arial', label: 'Arial', note: 'Plain', stack: `Arial, Helvetica, ${SYSTEM}` },
  { id: 'verdana', label: 'Verdana', note: 'Wide, easy to read', stack: `Verdana, Geneva, ${SYSTEM}` },
  { id: 'tahoma', label: 'Tahoma', note: 'Compact', stack: `Tahoma, Verdana, ${SYSTEM}` },
  { id: 'trebuchet', label: 'Trebuchet MS', note: 'Rounded', stack: `"Trebuchet MS", ${SYSTEM}` },
  { id: 'calibri', label: 'Calibri', note: 'Soft', stack: `Calibri, Carlito, ${SYSTEM}` },
  { id: 'georgia', label: 'Georgia', note: 'Serif', stack: `Georgia, "Times New Roman", serif` },
  { id: 'consolas', label: 'Consolas', note: 'Monospace', stack: `Consolas, "Cascadia Mono", ui-monospace, monospace` },
]

export const FONT_IDS = FONTS.map((f) => f.id)

export function fontStack(id: unknown): string {
  return FONTS.find((f) => f.id === id)?.stack ?? SYSTEM
}

/** The app's font choice as saved by Settings (for the search bar, which does not load the settings store). */
export function savedFontStack(): string {
  try {
    const raw = JSON.parse(localStorage.getItem('tarkov-companion-prefs') ?? 'null') as { state?: { fontFamily?: unknown } } | null
    return fontStack(raw?.state?.fontFamily)
  } catch {
    return SYSTEM
  }
}

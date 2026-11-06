/**
 * Puts the Appearance settings on <html>: theme and density as data attributes (index.css
 * has the matching rules), text size as the root font size (every rem-based size follows), the
 * font as the --font-sans token every text uses.
 * Runs before the first render and again on every change.
 */
import { usePrefs, type Prefs } from '../store/prefs'
import { fontStack } from './fonts'

function apply(p: Pick<Prefs, 'theme' | 'uiScale' | 'fontFamily' | 'density' | 'reduceMotion' | 'markerScale'>) {
  const root = document.documentElement
  root.dataset.theme = p.theme
  root.dataset.density = p.density
  root.dataset.reduceMotion = String(p.reduceMotion)
  root.style.fontSize = p.uiScale === 100 ? '' : `${p.uiScale}%`
  if (p.fontFamily === 'system') root.style.removeProperty('--font-sans')
  else root.style.setProperty('--font-sans', fontStack(p.fontFamily))
  root.classList.toggle('dark', p.theme !== 'daylight' && p.theme !== 'arctic')
  root.style.setProperty('--tc-marker-scale', String(p.markerScale / 100))
}

let started = false
export function startAppearance() {
  if (started) return
  started = true
  apply(usePrefs.getState())
  usePrefs.subscribe((p, prev) => {
    if (p.theme !== prev.theme || p.uiScale !== prev.uiScale || p.fontFamily !== prev.fontFamily || p.density !== prev.density || p.reduceMotion !== prev.reduceMotion || p.markerScale !== prev.markerScale) apply(p)
  })
}

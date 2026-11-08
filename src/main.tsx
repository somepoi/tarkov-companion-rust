import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
// Leaflet's own stylesheet first: the app's dark map styles in index.css must come after it (when it
// loaded later with the lazy map, its white pop-ups and buttons won in the search bar).
import 'leaflet/dist/leaflet.css'
import './index.css'

import { bootstrapDesktop } from './desktop/bootstrap'

async function start() {
  await bootstrapDesktop()
  // The search bar over the game (desktop) is its own small window: only the bar, no app, no game log.
  const isSearchBar = window.desktop?.windowKind === 'searchbar'
  // Each window loads only its own code: the search bar never loads the app's pages, stores and game-log bridge.
  const Root = isSearchBar
    ? lazy(() =>
        import('./searchbar/SearchBarApp').then((m) => ({
          default: m.SearchBarApp,
        })),
      )
    : lazy(() => import('./App.tsx'))

  // The assistant was removed in 2.8.0: drop what it kept on this PC (settings, memory, the cached
  // speech model), once.
  if (!isSearchBar) {
    try {
      if (!localStorage.getItem('tc-assistant-removed')) {
        for (const k of [
          'tarkov-companion-assistant',
          'tarkov-companion-assistant-memory',
        ])
          localStorage.removeItem(k)
        void indexedDB
          .databases?.()
          .then((dbs) =>
            dbs.forEach(
              (d) =>
                d.name &&
                /vosk/i.test(d.name) &&
                indexedDB.deleteDatabase(d.name),
            ),
          )
        localStorage.setItem('tc-assistant-removed', '1')
      }
    } catch {
      // Only tidying up.
    }
  }

  // Theme and text size before the first paint (no flash of the default theme).
  if (!isSearchBar) {
    const { startAppearance } = await import('./lib/appearance')
    startAppearance()
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </StrictMode>,
  )
}

void start().catch(async (error: unknown) => {
  const root = document.getElementById('root')
  if (!root) return
  root.textContent = `Could not start Tarkov Companion Rust: ${error instanceof Error ? error.message : String(error)}`
  const { isTauri, invoke } = await import('@tauri-apps/api/core')
  if (!isTauri()) return
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
  if (getCurrentWebviewWindow().label !== 'main') return
  const button = document.createElement('button')
  const recoveryError = document.createElement('p')
  recoveryError.setAttribute('role', 'alert')
  button.textContent = 'Return to original profile and restart'
  button.className = 'btn'
  button.onclick = () => {
    button.disabled = true
    recoveryError.textContent = ''
    void invoke('native_backup', {
      operation: { operation: 'revert' },
    }).catch((cause: unknown) => {
      recoveryError.textContent = `Could not return to the original profile. ${cause instanceof Error ? cause.message : String(cause)}`
      button.disabled = false
    })
  }
  root.append(document.createElement('br'), button, recoveryError)
})

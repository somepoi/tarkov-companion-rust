import { Suspense, lazy, useEffect, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { ErrorBoundary } from './ErrorBoundary'
import { usePrefs } from '../store/prefs'
import { NAV_ITEMS } from '../config/nav'
import { FirstRunSetup } from '../desktop/FirstRunSetup'
import { SyncReviewDialog, SyncToast } from '../desktop/SyncReview'
import { useScanStore } from '../scan/scanStore'
import { routeCapturedImage } from '../scan/captureDestination'
import { UpdateBanner } from '../desktop/UpdateBanner'
import { hasAnyProgress, useLocalFlags } from '../desktop/localFlags'
import { isDesktop, useDesktopStore } from '../desktop/useDesktop'
import { useProgressStore } from '../store/progress'
import { useMapOverlayStore } from '../store/mapOverlay'
import { followOtherWindows } from '../lib/crossWindow'
import { useStoryStore } from '../store/story'
import { useInventoryStore } from '../store/inventory'
import { WipeBanner } from '../desktop/WipeBanner'
import { ItemLookup } from './ItemLookup'
import { StoryTimerWatcher } from '../story/StoryTimerWatcher'
import { AutoUntickCompleted } from '../maps/AutoUntick'
import { WikiTickCarryOver } from '../quests/WikiTickCarryOver'
import { RaidBriefingHost } from '../briefing/RaidBriefingHost'
import { PositionListener, usePositionStore } from '../maps/position'
import { AutoBackup } from '../desktop/HealthAndBackups'
import { Sidebar } from './Sidebar'

/** The start page from Settings is applied once per app start (later visits to / stay on the Dashboard). */
let landingApplied = false

function PageLoading() {
  return (
    <div className="flex items-center gap-2 p-8 text-sm text-ink-muted">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </div>
  )
}

export function Layout() {
  const [captureError, setCaptureError] = useState('')
  const [searchbarError, setSearchbarError] = useState('')
  useEffect(() => window.desktop?.onSearchBarError?.(setSearchbarError), [])
  const positionError = usePositionStore((s) => s.error)
  useEffect(() => window.desktop?.onScanCaptureError?.(setCaptureError), [])
  useEffect(() => { void window.desktop?.reportUiReady?.().catch(() => undefined) }, [])
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const landingPage = usePrefs((s) => s.landingPage)
  const hiddenTabs = usePrefs((s) => s.hiddenTabs)
  const liveTickToast = usePrefs((s) => s.liveTickToast)
  const autoBackup = usePrefs((s) => s.autoBackup)
  // Number and time formats are read while drawing: re-draw the page when they change.
  const formatKey = usePrefs((s) => `${s.numberStyle}|${s.timeFormat}|${s.compactPrices}|${s.priceSource}|${s.fleaFeeDiscount}`)
  useEffect(() => {
    if (landingApplied) return
    landingApplied = true
    const valid = NAV_ITEMS.some((i) => i.path === landingPage && !hiddenTabs.includes(i.path)) || landingPage === '/settings'
    if (pathname === '/' && landingPage !== '/' && valid) navigate(landingPage, { replace: true })
  }, [landingPage, hiddenTabs, pathname, navigate])
  // Desktop scan hotkey: the main process captured the game screen; open the scanner with it.
  useEffect(() => window.desktop?.onScanCapture((png) => {
    const image = new Blob([png as BlobPart], { type: 'image/png' })
    // An already-open Item Collection scanner keeps its active capture flow.
    if (useScanStore.getState().open || !routeCapturedImage(image))
      useScanStore.getState().openWith(image)
  }), [])
  // Desktop search bar over the game: what is ticked or counted there (quests "On map", quests done,
  // items, keys, hideout levels, story steps) shows in the app at once.
  useEffect(() => (isDesktop() ? followOtherWindows([useMapOverlayStore, useProgressStore, useInventoryStore, useStoryStore]) : undefined), [])
  // Desktop search bar over the game: "Open in the app" on one of its results.
  useEffect(() => window.desktop?.onOpenInApp((to) => to.startsWith('/') && navigate(to)), [navigate])
  const settings = useDesktopStore((s) => s.settings)
  const settingsError = useDesktopStore((s) => s.settingsError)
  const localSetupDone = useLocalFlags((s) => s.setupDone)
  const hasProgress = useProgressStore((s) => hasAnyProgress(s.profiles))
  // Set up here before (this progress store), or set up in an earlier version and already has quests ticked.
  const needsSetup = isDesktop() && settings !== null && !localSetupDone && !(settings.setupDone && hasProgress)
  // Once shown, keep the setup open until Done (ticking quests mid-way must not close it).
  const [setupShown, setSetupShown] = useState(false)
  if (needsSetup && !setupShown) setSetupShown(true)
  const showSetup = isDesktop() && !localSetupDone && (needsSetup || setupShown)
  const fullBleed =
    pathname.startsWith('/dev/') || NAV_ITEMS.some((i) => i.fullBleed && i.path === pathname)

  return (
    <div className="flex h-full bg-surface text-ink">
      <ErrorBoundary area="Item lookup" quiet>
        <ItemLookup />
      </ErrorBoundary>
      <ErrorBoundary area="Story timers" quiet>
        <StoryTimerWatcher />
        <AutoUntickCompleted />
        <WikiTickCarryOver />
      </ErrorBoundary>
      <ErrorBoundary area="Raid briefing" quiet>
        {/* Briefs when the game log (desktop) says a map is loading. */}
        <RaidBriefingHost />
      </ErrorBoundary>
      {isDesktop() && (
        <ErrorBoundary area="Game log features" quiet>
          <PositionListener />
          {autoBackup && <AutoBackup />}
          {isDesktop() && <SyncReviewDialog />}
          {liveTickToast && <SyncToast />}
        </ErrorBoundary>
      )}
      {showSetup && <FirstRunSetup />}
      <ErrorBoundary area="The stash scanner" quiet>
        <ScanDialogHost />
      </ErrorBoundary>
      <Sidebar />
      <main className={`min-w-0 flex-1 ${fullBleed ? 'flex min-h-0 flex-col overflow-hidden' : 'overflow-y-auto'}`}>
        <UpdateBanner />
        {settingsError && <div role="alert" className="flex items-center justify-between gap-3 border-b border-danger/50 bg-surface px-4 py-2 text-sm text-danger"><span>Could not save desktop settings. {settingsError}</span><button type="button" className="btn" onClick={() => useDesktopStore.setState({ settingsError: null })}>Dismiss</button></div>}
        {searchbarError && <div role="alert" className="flex items-center justify-between gap-3 border-b border-danger/50 bg-surface px-4 py-2 text-sm text-danger"><span>Searchbar: {searchbarError}</span><button className="btn" onClick={() => setSearchbarError('')}>Dismiss</button></div>}
        {captureError && <div role="alert" className="flex items-center justify-between gap-3 border-b border-danger/50 bg-surface px-4 py-2 text-sm text-danger"><span>Screenshot capture failed: {captureError}</span><button className="btn" onClick={() => setCaptureError('')}>Dismiss</button></div>}
        <WipeBanner />
        {positionError && <div role="alert" className="flex items-center justify-between gap-3 border-b border-danger/50 bg-surface px-4 py-2 text-sm text-danger"><span>Position tracking: {positionError}</span><button className="btn" onClick={() => usePositionStore.getState().setError(null)}>Dismiss</button></div>}
        {fullBleed ? (
          <ErrorBoundary key={`${pathname}|${formatKey}`} area={areaName(pathname)}>
            <Suspense fallback={<PageLoading />}>
              <Outlet />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8">
            <ErrorBoundary key={`${pathname}|${formatKey}`} area={areaName(pathname)}>
              <Suspense fallback={<PageLoading />}>
                <Outlet />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
      </main>
    </div>
  )
}

// The stash scanner (and its text reader) is loaded the first time it opens.
const ScanDialog = lazy(() => import('../scan/ScanDialog').then((m) => ({ default: m.ScanDialog })))
function ScanDialogHost() {
  const open = useScanStore((s) => s.open)
  return open ? (
    <Suspense fallback={null}>
      <ScanDialog />
    </Suspense>
  ) : null
}

function areaName(pathname: string): string {
  if (pathname === '/settings') return 'the Settings page'
  if (pathname === '/features') return 'the Features & patches page'
  const tab = NAV_ITEMS.find((i) => i.path === pathname)
  return tab ? `the ${tab.label} tab` : 'this page'
}

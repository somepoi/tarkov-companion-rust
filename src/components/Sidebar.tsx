import { NavLink, useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Search, Settings, Sparkles, Shield } from 'lucide-react'
import { useLookupStore } from '../store/lookup'
import { NAV_GROUPS, visibleNav } from '../config/nav'
import { TAB_COLORS, usePrefs } from '../store/prefs'
import { GAME_MODES } from '../api/client'
import { useProgressStore } from '../store/progress'
import { WatcherStatus } from '../desktop/WatcherStatus'
import { APP_NAME } from '../lib/app-info'

function GameModeToggle({ compact }: { compact: boolean }) {
  const gameMode = useProgressStore((s) => s.gameMode)
  const setGameMode = useProgressStore((s) => s.setGameMode)

  if (compact) {
    const other = GAME_MODES.find((m) => m.id !== gameMode) ?? GAME_MODES[0]
    const current = GAME_MODES.find((m) => m.id === gameMode) ?? GAME_MODES[0]
    return (
      <button
        type="button"
        onClick={() => setGameMode(other.id)}
        title={`Game mode: ${current.label}. Click to switch to ${other.label}.`}
        className="mx-auto flex h-9 w-10 items-center justify-center rounded border border-accent/50 bg-accent/10 text-xs font-bold text-accent hover:bg-accent/20"
      >
        {current.label}
      </button>
    )
  }

  return (
    <div className="flex rounded border border-line bg-surface p-0.5" role="group" aria-label="Game mode">
      {GAME_MODES.map((m) => {
        const active = m.id === gameMode
        return (
          <button
            key={m.id}
            type="button"
            title={m.description}
            onClick={() => setGameMode(m.id)}
            aria-pressed={active}
            className={`flex-1 rounded px-2 py-1 text-xs font-semibold transition-colors ${
              active ? 'bg-accent text-surface' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {m.label}
          </button>
        )
      })}
    </div>
  )
}

export function Sidebar() {
  const collapsed = usePrefs((s) => s.sidebarCollapsed)
  const setPref = usePrefs((s) => s.set)
  const setCollapsed = (fn: (c: boolean) => boolean) => setPref('sidebarCollapsed', fn(collapsed))
  const hiddenTabs = usePrefs((s) => s.hiddenTabs)
  const tabColors = usePrefs((s) => s.tabColors)
  const navigate = useNavigate()
  const openSettings = (section?: string) => navigate(section ? `/settings#${section}` : '/settings')

  // Below the md breakpoint the sidebar always shows icons only.
  const widthClass = collapsed ? 'w-16' : 'w-16 md:w-60'
  const labelClass = collapsed ? 'hidden' : 'hidden md:inline'
  const wideOnlyClass = collapsed ? 'hidden' : 'hidden md:block'

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-line bg-surface-2 transition-[width] duration-200 ${widthClass}`}
    >
      <div className="flex h-14 items-center gap-2 border-b border-line px-3">
        <Shield className="h-6 w-6 shrink-0 text-accent" aria-hidden />
        <span className={`truncate text-sm font-semibold tracking-wide ${labelClass}`}>
          {APP_NAME}
        </span>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="ml-auto hidden rounded p-1 text-ink-dim hover:bg-surface-3 hover:text-ink md:block"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      <div className="px-2 pt-2">
        <button
          type="button"
          onClick={() => useLookupStore.getState().setOpen(true)}
          title="Item lookup (Ctrl+K)"
          className="flex w-full items-center gap-3 rounded border border-line bg-surface px-2.5 py-1.5 text-sm text-ink-muted hover:border-accent hover:text-ink"
        >
          <Search className="h-4 w-4 shrink-0" aria-hidden />
          <span className={`flex-1 truncate text-left ${labelClass}`}>Item lookup</span>
          <kbd className={`rounded border border-line px-1 text-[10px] text-ink-dim ${labelClass}`}>Ctrl K</kbd>
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto py-2" aria-label="Main">
        {NAV_GROUPS.map((g, gi) => {
          const tabs = visibleNav(hiddenTabs).filter((i) => i.group === g.id)
          if (!tabs.length) return null
          return (
            <div key={g.id} className={gi ? 'mt-2' : ''}>
              {/* Section heading when the sidebar is wide; a thin divider when it shows icons only. */}
              <div className={`px-4 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-ink-dim ${wideOnlyClass}`}>{g.label}</div>
              {gi > 0 && <div className={`mx-3 mb-1 border-t border-line ${collapsed ? 'block' : 'block md:hidden'}`} aria-hidden />}
              <ul className="space-y-0.5 px-2">
                {tabs.map((item) => {
                  const color = tabColors[item.path] ? TAB_COLORS.find((c) => c.id === tabColors[item.path])?.hex : undefined
                  return (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
                        end={item.path === '/'}
                        title={item.label}
                        style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}
                        className={({ isActive }) =>
                          `flex items-center gap-3 rounded px-2.5 py-2 text-sm transition-colors ${
                            isActive
                              ? 'bg-accent/15 text-accent'
                              : 'text-ink-muted hover:bg-surface-3 hover:text-ink'
                          }`
                        }
                      >
                        <item.icon className="h-5 w-5 shrink-0" style={color ? { color } : undefined} aria-hidden />
                        <span className={`truncate ${labelClass}`}>{item.label}</span>
                      </NavLink>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </nav>

      <div className="space-y-2 border-t border-line p-2">
        <div className={wideOnlyClass}>
          <GameModeToggle compact={false} />
        </div>
        <div className={collapsed ? 'block' : 'block md:hidden'}>
          <GameModeToggle compact />
        </div>
        <div className={collapsed ? 'block' : 'hidden md:block'}>
          <WatcherStatus compact={collapsed} onClick={() => openSettings('desktop')} />
        </div>
        <div className={collapsed ? 'hidden' : 'block md:hidden'}>
          <WatcherStatus compact onClick={() => openSettings('desktop')} />
        </div>
        <NavLink
          to="/features"
          title="Features & patches"
          className={({ isActive }) =>
            `flex w-full items-center gap-3 rounded px-2.5 py-2 text-sm transition-colors ${isActive ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:bg-surface-3 hover:text-ink'}`
          }
        >
          <Sparkles className="h-5 w-5 shrink-0" aria-hidden />
          <span className={labelClass}>Features & patches</span>
        </NavLink>
        <NavLink
          to="/settings"
          title="Settings"
          className={({ isActive }) =>
            `flex w-full items-center gap-3 rounded px-2.5 py-2 text-sm transition-colors ${isActive ? 'bg-accent/15 text-accent' : 'text-ink-muted hover:bg-surface-3 hover:text-ink'}`
          }
        >
          <Settings className="h-5 w-5 shrink-0" aria-hidden />
          <span className={labelClass}>Settings</span>
        </NavLink>
      </div>
    </aside>
  )
}

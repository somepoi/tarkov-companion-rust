import { Component, type ErrorInfo, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw, Trash2 } from 'lucide-react'
import { queryClient } from '../api/queryClient'
import { clearOfflineCache } from '../api/persist'

interface Props {
  children: ReactNode
  /** Short name for the message ("this page", "the map panel"). */
  area?: string
  /** Small inline notice instead of the full-page panel (for side widgets). */
  quiet?: boolean
}
interface State {
  error: Error | null
}

/**
 * Catches a crash while drawing part of the app, so one broken screen (e.g. unexpected data
 * from tarkov.dev) never blanks the whole window. Offers a retry and, because bad data is
 * cached for offline use, a way to drop the cached game data and download it again.
 * Your own progress is never touched by these buttons.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.area ?? 'page', error, info.componentStack)
  }

  private retry = () => this.setState({ error: null })

  private clearCache = async () => {
    queryClient.clear()
    await clearOfflineCache().catch(() => undefined)
    window.location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.quiet) {
      return (
        <p className="m-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-xs text-danger">
          {this.props.area ?? 'This part'} stopped working.{' '}
          <button type="button" onClick={this.retry} className="underline">
            Try again
          </button>
        </p>
      )
    }
    return (
      <div className="mx-auto mt-10 max-w-xl rounded-lg border border-danger/40 bg-surface-2 p-6" role="alert">
        <h2 className="flex items-center gap-2 text-base font-semibold text-danger">
          <AlertTriangle className="h-5 w-5" /> Something went wrong on {this.props.area ?? 'this page'}
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          The rest of the app still works: pick another tab on the left. Your progress is safe. If this keeps happening, the cached game
          data may be damaged; clearing it downloads a fresh copy.
        </p>
        <pre className="mt-3 max-h-32 overflow-auto rounded bg-surface p-2 text-xs text-ink-dim">{error.message}</pre>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" onClick={this.retry} className="btn">
            <RefreshCw className="h-4 w-4" /> Try again
          </button>
          <button type="button" onClick={() => void this.clearCache()} className="btn">
            <Trash2 className="h-4 w-4" /> Clear cached game data and reload
          </button>
        </div>
      </div>
    )
  }
}

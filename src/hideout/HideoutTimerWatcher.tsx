import { useEffect } from 'react'
import { notificationsAllowed, notify } from '../lib/notify'
import { useHideoutTimers } from '../store/hideoutTimers'

/**
 * Runs in the layout, whatever tab is open: when a hideout build timer ends, shows a system
 * notification once ("Generator level 2 should be finished").
 */
export function HideoutTimerWatcher() {
  useEffect(() => {
    const check = () => {
      if (!notificationsAllowed('hideout')) return
      const { byMode, markNotified } = useHideoutTimers.getState()
      const now = Date.now()
      for (const mode of ['regular', 'pve'] as const) {
        for (const [stationId, t] of Object.entries(byMode[mode])) {
          if (t.notified || now < t.endsAt) continue
          const sent = notify('hideout', 'Hideout build finished', {
            body: `${t.label} should be finished. Mark it built on the Hideout tab.`,
            tag: `hideout-${mode}-${stationId}`,
          })
          if (sent) markNotified(mode, stationId)
        }
      }
    }
    check()
    const id = setInterval(check, 30_000)
    return () => clearInterval(id)
  }, [])
  return null
}

/**
 * System notifications, filtered by Settings → Notifications (master switch plus one switch
 * per kind). Asks for permission only from a click (browsers ignore requests otherwise).
 */
import { prefs } from '../store/prefs'

export type NotifyKind = 'trader' | 'story' | 'hideout' | 'test'

export function notificationsAllowed(kind: NotifyKind): boolean {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false
  const p = prefs()
  if (!p.notifications) return false
  if (kind === 'story') return p.storyTimerAlerts
  return true
}

export function notify(kind: NotifyKind, title: string, options: NotificationOptions = {}): boolean {
  if (!notificationsAllowed(kind)) return false
  try {
    new Notification(title, options)
    return true
  } catch {
    return false
  }
}

/** Current browser permission: granted / denied / default (not asked yet) / unsupported. */
export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

export async function askNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported'
  if (Notification.permission !== 'default') return Notification.permission
  return Notification.requestPermission()
}

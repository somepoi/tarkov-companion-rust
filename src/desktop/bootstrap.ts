/** Initialize the native bridge before any app module reads it. */
export async function bootstrapDesktop(): Promise<void> {
  if (window.desktop) return
  const { isTauri } = await import('@tauri-apps/api/core')
  if (!isTauri()) return
  const { createTauriDesktop } = await import('./adapters/tauri')
  window.desktop = await createTauriDesktop()
  // Recovery writes shared renderer storage and the native command is main-window-only.
  if (window.desktop.windowKind !== 'main') return
  const { restorePendingRenderer } = await import('../inventory/rendererBackup')
  await restorePendingRenderer()
}

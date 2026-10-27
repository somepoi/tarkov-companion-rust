/** Keep Electron preload authoritative; initialize Tauri before any app module reads it. */
export async function bootstrapDesktop(): Promise<void> {
  if (window.desktop) return
  const { isTauri } = await import('@tauri-apps/api/core')
  if (!isTauri()) return
  const { createTauriDesktop } = await import('./adapters/tauri')
  window.desktop = await createTauriDesktop()
  const { restorePendingRenderer } = await import('../inventory/rendererBackup')
  await restorePendingRenderer()
}

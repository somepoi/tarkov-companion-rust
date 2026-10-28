import { useLayoutEffect, type RefObject } from 'react'

/** Native shaped windows replace Electron's forwarded pointer movement. No idle timer. */
export function useNativeRegions(box: RefObject<HTMLElement | null>, onError: (message: string) => void) {
  useLayoutEffect(() => {
    const api = window.desktop
    if (!api?.setSearchBarRegions) return
    let active = true, running = false, urgent = false, frame = 0, revision = 0, geometry = 0
    let sent = ''
    const observed = new Set<Element>()
    const schedule = () => {
      revision++
      if (!frame && !running) frame = requestAnimationFrame(() => { frame = 0; void send() })
    }
    const resize = new ResizeObserver(schedule)
    const flush = () => {
      revision++; urgent = true
      if (frame) { cancelAnimationFrame(frame); frame = 0 }
      if (!running) void send()
    }
    const send = async () => {
      if (!active || running || !box.current) return
      running = true
      urgent = false
      const current = revision
      try {
        const solids = [...document.querySelectorAll('[data-solid]')].filter((el) => !el.parentElement?.closest('[data-solid]'))
        if (solids.length > 128) throw new Error('Searchbar exceeds the supported input region count')
        for (const el of observed) if (!solids.includes(el)) { resize.unobserve(el); observed.delete(el) }
        for (const el of solids) if (!observed.has(el)) { observed.add(el); resize.observe(el) }
        const regions = solids.map((el) => el.getBoundingClientRect()).map((r) => {
          const x = Math.max(0, r.left), y = Math.max(0, r.top)
          return { x, y, width: Math.max(0, Math.min(window.innerWidth, r.right) - x), height: Math.max(0, Math.min(window.innerHeight, r.bottom) - y) }
        }).filter((r) => r.width > 0 && r.height > 0)
        const bounds = box.current.getBoundingClientRect()
        const size = [Math.ceil(bounds.width) + 8, Math.ceil(bounds.height) + 8] as const
        const signature = JSON.stringify([geometry, size, regions])
        if (signature !== sent) {
          await api.setSearchBarSize(...size)
          if (!active) return
          await api.setSearchBarRegions!(regions)
          sent = signature
        }
      } catch (error) {
        if (active) onError(error instanceof Error ? error.message : String(error))
      } finally {
        running = false
        if (active && revision !== current) { if (urgent) void send(); else schedule() }
      }
    }
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'data-solid'] })
    window.addEventListener('resize', schedule)
    const stopGeometry = api.onSearchBarGeometry?.(() => { geometry++; sent = ''; flush() })
    resize.observe(box.current ?? document.body)
    // A hidden WebView may suspend animation frames; first/DPI masks must not wait for one.
    flush()
    return () => {
      active = false
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize', schedule)
      stopGeometry?.()
    }
  }, [box, onError])
}

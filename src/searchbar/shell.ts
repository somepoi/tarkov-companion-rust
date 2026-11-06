import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { create } from 'zustand'

/** Which way things open from the glass (towards the side of the screen with more room). */
export interface Flip {
  left: boolean
  up: boolean
}

/** The column holding the glass/bar and the result list under (or, flipped, above) it. */
export const columnClass = (flip: Flip) => `flex flex-col gap-1 ${flip.up ? 'flex-col-reverse' : ''} ${flip.left ? 'items-end' : 'items-start'}`

export type DragProps = {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void
  onPointerMove: (e: PointerEvent<HTMLElement>) => void
  onPointerUp: (e: PointerEvent<HTMLElement>) => void
  onPointerCancel: (e: PointerEvent<HTMLElement>) => void
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void
}

/** Drags and resizes going on: while there are any, the bar's window takes the mouse everywhere. */
export const useDragging = create<{ count: number; begin: () => void; end: () => void }>()((set) => ({
  count: 0,
  begin: () => set((s) => ({ count: s.count + 1 })),
  end: () => set((s) => ({ count: Math.max(0, s.count - 1) })),
}))

/**
 * Drag with the mouse: `onMove` gets the window-local pixels moved since the press, `onEnd` runs when
 * it is let go. A press without moving is a click (and Enter/Space on the focused handle).
 * A release the handle never hears (the window lost the mouse, the box closed) still ends the
 * drag, so the bar's window never keeps the whole screen's mouse.
 */
export function useDrag(h: { onStart?: () => void; onMove?: (dx: number, dy: number) => void; onEnd?: () => void; onClick?: () => void }): DragProps {
  const st = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const unwatch = useRef<(() => void) | null>(null)
  // The newest handlers (they close over the newest state).
  const handlers = useRef(h)
  useLayoutEffect(() => {
    handlers.current = h
  })
  // Closed mid-drag: give the mouse back.
  useEffect(
    () => () => {
      unwatch.current?.()
      unwatch.current = null
      if (st.current?.moved) useDragging.getState().end()
      st.current = null
    },
    [],
  )
  /** Window-wide watch while dragging: a release anywhere, a move with no button down, leaving the window. */
  const watch = () => {
    const up = () => end(false)
    const move = (e: globalThis.PointerEvent) => {
      if (e.buttons === 0) end(false)
    }
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointermove', move, true)
    window.addEventListener('blur', up)
    unwatch.current = () => {
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointermove', move, true)
      window.removeEventListener('blur', up)
    }
  }
  const end = (click: boolean) => {
    unwatch.current?.()
    unwatch.current = null
    const s = st.current
    st.current = null
    if (!s) return
    if (s.moved) {
      useDragging.getState().end()
      handlers.current.onEnd?.()
    } else if (click) handlers.current.onClick?.()
  }
  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      // Buttons and fields inside a move bar keep working (a drag would steal their click).
      const hit = (e.target as Element).closest?.('button, a, input, select, textarea, [data-nodrag]')
      if (hit && hit !== e.currentTarget) return
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        // the pointer is already gone
      }
      st.current = { x: e.clientX, y: e.clientY, moved: false }
    },
    onPointerMove: (e) => {
      const s = st.current
      if (!s) return
      const dx = e.clientX - s.x
      const dy = e.clientY - s.y
      if (!s.moved) {
        if (Math.hypot(dx, dy) < 4) return
        s.moved = true
        useDragging.getState().begin()
        watch()
        handlers.current.onStart?.()
      }
      handlers.current.onMove?.(dx, dy)
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onKeyDown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      handlers.current.onClick?.()
    },
  }
}

/** A clock that ticks only while something on screen needs it (null = stopped). */
export function useNow(everyMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!everyMs) return
    const t = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(t)
  }, [everyMs])
  return now
}

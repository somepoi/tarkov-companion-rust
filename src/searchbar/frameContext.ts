import { createContext, useContext } from 'react'
import type { Point, Rect } from './boxes'
import type { Flip } from './shell'

/** The bar's window and glass (screen pixels), which way things open, and the size setting. */
export interface FrameInfo {
  frame: Rect
  anchor: Point
  flip: Flip
  zoom: number
}

export const FrameContext = createContext<FrameInfo>({
  frame: { x: 0, y: 0, width: 1920, height: 1040 },
  anchor: { x: 16, y: 16 },
  flip: { left: false, up: false },
  zoom: 1,
})

export const useFrame = () => useContext(FrameContext)

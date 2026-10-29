/// <reference lib="webworker" />
import { inventoryExport } from './exportFacts'
import type { Inventory } from './client'
const ctx = self as unknown as DedicatedWorkerGlobalScope
ctx.onmessage = ({ data }: MessageEvent<{ inventory: Inventory; format: 'json' | 'csv'; at: string }>) => {
  try { ctx.postMessage({ blob: inventoryExport(data.inventory, data.format, data.at) }) }
  catch (error) { ctx.postMessage({ error: error instanceof Error ? error.message : String(error) }) }
}

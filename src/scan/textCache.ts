import type { OcrWord } from './core'

// Process-local suggestions only: never evidence of physical identity or review.
const entries = new Map<string, { words: OcrWord[]; charge: number }>()
let charged = 0
const BUDGET = 1024 * 1024
export function clearTextCache(): void { entries.clear(); charged = 0 }
export function cachedText(key: string): OcrWord[] | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  entries.delete(key)
  entries.set(key, entry)
  return entry.words
}
export function cacheText(key: string, words: OcrWord[]): void {
  if (words.length > 4096) return
  const charge = words.reduce((sum, word) => sum + 128 + word.text.length * 2, key.length * 2)
  if (charge > BUDGET) return
  const old = entries.get(key)
  if (old) { entries.delete(key); charged -= old.charge }
  while (entries.size && (entries.size >= 8 || charged + charge > BUDGET)) {
    const oldest = entries.keys().next().value!
    charged -= entries.get(oldest)!.charge
    entries.delete(oldest)
  }
  entries.set(key, { words, charge })
  charged += charge
}

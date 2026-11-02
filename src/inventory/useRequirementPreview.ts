import { useEffect, useRef, useState } from 'react'
import { inventoryCall } from './client'
import type { NormalizedRequirements, RequirementsSource } from './requirements'

/** One in-flight preview and one replaceable latest intent. Late results can
 * never make an old source current, even when a native operation cannot cancel. */
export function useRequirementPreview(input: RequirementsSource) {
  const [state, setState] = useState<{ input: RequirementsSource; value?: NormalizedRequirements; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const latest = useRef(input)
  const ready = useRef<RequirementsSource | null>(null)
  const running = useRef(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false; ready.current = null } }, [])
  useEffect(() => {
    latest.current = input
    ready.current = null
    const drain = async () => {
      if (running.current) return
      running.current = true
      try {
        while (alive.current && ready.current) {
          const source = ready.current
          ready.current = null
          try {
            const value = await inventoryCall<NormalizedRequirements>({ operation: 'normalizeRequirements', input: source })
            if (alive.current && latest.current === source) setState({ input: source, value })
          } catch (cause) {
            if (alive.current && latest.current === source) setState({ input: source, error: cause instanceof Error ? cause.message : String(cause) })
          }
        }
      } finally { running.current = false }
    }
    const timer = setTimeout(() => { ready.current = input; void drain() }, 200)
    return () => { clearTimeout(timer); if (ready.current === input) ready.current = null }
  }, [input, attempt])
  return { preview: state?.input === input ? state : null, retry: () => { setState(null); setAttempt((n) => n + 1) } }
}

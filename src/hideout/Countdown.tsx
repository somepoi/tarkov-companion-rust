import { useNow } from '../searchbar/shell'
import { timeLeft } from './look'

/** Time left to `endsAt`, ticking every second (only this text re-renders). */
export function Countdown({ endsAt }: { endsAt: number }) {
  const now = useNow(1000)
  return <>{timeLeft(endsAt - now)}</>
}

/** A thin bar filling up from `startedAt` to `endsAt`. */
export function TimerBar({ startedAt, endsAt }: { startedAt: number; endsAt: number }) {
  const now = useNow(1000)
  const pct = endsAt > startedAt ? Math.min(100, Math.max(0, ((now - startedAt) / (endsAt - startedAt)) * 100)) : 100
  return (
    <div className="tc-meter tc-meter-info" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Build progress">
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

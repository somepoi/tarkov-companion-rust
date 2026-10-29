import { useEffect, useState } from 'react'
import type { ItemsBundle } from '../api/types'
import type { Inventory, RecommendationPlan } from './client'
import { estimateListing, validFeeModifiers } from '../lib/fleaFees'

const price = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= Number.MAX_SAFE_INTEGER
const rub = (n: number) => new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(n) + ' RUB'
/** Reference values cannot authorize a sale or change the allocator's verdict. */
export function SurplusValue({ plan, inventory, catalog, level }: { plan: RecommendationPlan; inventory: Inventory; catalog?: ItemsBundle; level: number }) {
  const [online, setOnline] = useState(navigator.onLine)
  const [now, setNow] = useState(() => Date.now())
  const [intelligenceCenter, setIntelligenceCenter] = useState('0')
  const [hideoutManagement, setHideoutManagement] = useState('0')
  const [modifiersConfirmed, setModifiersConfirmed] = useState(false)
  useEffect(() => { const update = () => { setOnline(navigator.onLine); setNow(Date.now()) }; window.addEventListener('online', update); window.addEventListener('offline', update); return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update) } }, [])
  if (!catalog || catalog.mode !== plan.mode || catalog.mode !== inventory.profile.mode) return <p className="text-xs text-ink-muted">Refresh this mode’s item catalog to enable surplus value references. Cached inventory recommendations remain available.</p>
  const market = catalog.fleaMarket
  const modifiers = { intelligenceCenter: intelligenceCenter === '' ? NaN : Number(intelligenceCenter), hideoutManagement: hideoutManagement === '' ? NaN : Number(hideoutManagement) }
  const canEstimate = modifiersConfirmed && validFeeModifiers(modifiers)
  const physical = new Map(inventory.containers.flatMap((entry) => entry.snapshot?.stacks.map((stack) => [`${entry.snapshot!.id}:${stack.id}`, stack] as const) ?? []))
  let trader = 0, flea = 0, units = 0, traderMissing = 0, fleaMissing = 0, stale = 0, unknownAge = 0
  let oldest = 0
  let feeGross = 0, listingFees = 0, net = 0, feeUnits = 0, feeMissing = 0
  for (const row of plan.stacks) {
    const amount = row.portions.reduce((sum, part) => sum + (part.recommendation === 'SELL' && Number.isSafeInteger(part.quantity) && part.quantity! > 0 ? part.quantity! : 0), 0)
    if (!amount) continue
    units += amount
    const stack = physical.get(`${row.snapshotId}:${row.stackId}`)
    const item = catalog.items[row.itemId ?? '']
    if (!stack || !item || stack.itemId !== item.id || !stack.provenance.identityConfirmed || !stack.provenance.quantityConfirmed || stack.quantity === null || amount > stack.quantity) { traderMissing += amount; fleaMissing += amount; feeMissing += amount; continue }
    const at = item.updated ? Date.parse(item.updated) : NaN
    const fetched = catalog.fetchedAt
    const knownAge = Number.isFinite(at) && at > 0 && at <= now + 300000 && typeof fetched === 'number' && Number.isFinite(fetched) && fetched > 0 && fetched <= now + 300000
    if (!knownAge) unknownAge += amount
    else { const age = Math.max(0, now - Math.min(at, fetched!)); oldest = Math.max(oldest, age); if (age > 3600000) stale += amount }
    const best = item.sellToTrader.reduce((max, offer) => price(offer.priceRUB) ? Math.max(max, offer.priceRUB) : max, 0)
    if (best && Number.isSafeInteger(Math.round(best * amount)) && trader + best * amount <= Number.MAX_SAFE_INTEGER) trader += best * amount
    else traderMissing += amount
    const minimum = market?.minPlayerLevel
    const itemLevel = item.fleaLevel
    const eligible = market?.enabled === true && typeof itemLevel === 'number' && typeof minimum === 'number' && Number.isSafeInteger(minimum) && minimum >= 0 && Number.isSafeInteger(level) && level >= Math.max(minimum, itemLevel)
      && Number.isSafeInteger(itemLevel) && itemLevel >= 0 && !item.types.includes('noFlea')
      && (market.foundInRaidRequired === false || market.foundInRaidRequired === true && stack.fir === 'yes')
    if (eligible && price(item.lastLowPrice) && Number.isSafeInteger(Math.round(item.lastLowPrice * amount)) && flea + item.lastLowPrice * amount <= Number.MAX_SAFE_INTEGER) {
      flea += item.lastLowPrice * amount
      const estimate = canEstimate && market ? estimateListing(item.basePrice, item.lastLowPrice, amount, market, modifiers) : null
      if (estimate && Number.isSafeInteger(feeGross + estimate.gross) && Number.isSafeInteger(listingFees + estimate.fee) && Number.isSafeInteger(net + estimate.net)) {
        feeGross += estimate.gross; listingFees += estimate.fee; net += estimate.net; feeUnits += amount
      } else feeMissing += amount
    } else { fleaMissing += amount; feeMissing += amount }
  }
  return <details className="border-y border-line py-3">
    <summary className="cursor-pointer text-sm font-medium">Surplus value references · {units} SELL units · {plan.mode === 'pve' ? 'PvE' : 'PvP'}</summary>
    <div className="mt-3 space-y-2 text-sm">
      <p>Best catalog trader buyback: {rub(trader)} · {traderMissing} units unpriced.</p>
      <p>Flea gross reference: {rub(flea)} · {fleaMissing} units restricted or unpriced.</p>
      <div className="space-y-2 border-t border-line pt-3">
        <p className="font-medium">Estimate listing fees</p>
        <div className="flex flex-wrap gap-3">
          <label className="grid gap-1 text-xs">Intelligence Center level
            <select className="rounded border border-line bg-surface px-2 py-1.5 text-sm" value={intelligenceCenter}
              onChange={(event) => { setIntelligenceCenter(event.target.value); setModifiersConfirmed(false) }}>
              {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className="grid gap-1 text-xs">Hideout Management skill level
            <input type="number" min={0} max={100} step={1} className="w-28 rounded border border-line bg-surface px-2 py-1.5 text-sm" value={hideoutManagement}
              onChange={(event) => { setHideoutManagement(event.target.value); setModifiersConfirmed(false) }} />
          </label>
        </div>
        <label className="flex gap-2 text-xs">
          <input type="checkbox" checked={modifiersConfirmed} disabled={!validFeeModifiers(modifiers)}
            onChange={(event) => { setModifiersConfirmed(event.target.checked); setNow(Date.now()) }} />
          I checked these levels for this character.
        </label>
        {canEstimate ? <p>Estimate for {feeUnits} units: {rub(feeGross)} gross − {rub(listingFees)} listing fees = {rub(net)} after fees. {feeMissing} units excluded because eligibility, price, fee data or arithmetic limits are unresolved.</p>
          : <p className="text-xs text-ink-muted">Confirm current character levels to estimate fees. Missing catalog rates or base values remain unknown.</p>}
        <p className="max-w-prose text-xs text-ink-muted">Assumes one listing per saved stack with individually purchasable units, all sold at the last low offer. Fees are rounded once per listing. Negative returns are preserved. Condition adjustments, pack offers, relisting costs and actual game charges are unverified.</p>
      </div>
      <p className="text-xs text-ink-muted">{online ? 'Network reported online' : 'Offline: cached catalog'} · evaluated {new Date(now).toLocaleString()} · oldest known quote/fetch age at evaluation: {oldest ? Math.ceil(oldest / 60000) + ' min' : 'less than one minute or unavailable'} · {stale} units older than one hour · {unknownAge} units with unknown quote age.</p>
      <p className="max-w-prose text-xs text-ink-muted">Historical catalog references, not guaranteed proceeds. After-fee figures use the catalog's two fee rates and a source-based estimate of character discounts. Item condition, trader access, offer slots and additional trade restrictions are unverified. These figures never change KEEP/SELL/REVIEW and do not initiate sales.</p>
    </div>
  </details>
}

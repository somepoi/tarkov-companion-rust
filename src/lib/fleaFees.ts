export interface FeeModifiers { intelligenceCenter: number; hideoutManagement: number }
export interface FeeRates { sellOfferFeeRate?: number | null; sellRequirementFeeRate?: number | null }
const positive = (value: number) => Number.isSafeInteger(value) && value > 0
const level = (value: number, maximum: number) => Number.isSafeInteger(value) && value >= 0 && value <= maximum
export const validFeeModifiers = (input: FeeModifiers) => level(input.intelligenceCenter, 3) && level(input.hideoutManagement, 100)
export const feeRate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/** Independently expressed from tarkov.dev's resolver contract, inspected 2026-10-29.
 * Individually purchasable units only: asking price is per unit; round once per listing.
 * Rates belong to the same mode/catalog as the quote. No fallback or safe-integer saturation.
 */
export function estimateListing(base: number, unitPrice: number, quantity: number, rates: FeeRates, modifiers: FeeModifiers): { gross: number; fee: number; net: number } | null {
  if (!positive(base) || !positive(unitPrice) || !positive(quantity) || !validFeeModifiers(modifiers)
    || !feeRate(rates.sellOfferFeeRate) || !feeRate(rates.sellRequirementFeeRate)) return null
  const gross = unitPrice * quantity
  if (!Number.isSafeInteger(gross)) return null
  // Only the positive logarithm is raised to the nonlinear exponent.
  const ratio = Math.log10(base / unitPrice)
  const offerExponent = ratio > 0 ? ratio ** 1.08 : ratio
  const priceExponent = ratio <= 0 ? (-ratio) ** 1.08 : -ratio
  const raw = quantity * (base * rates.sellOfferFeeRate * 4 ** offerExponent
    + unitPrice * rates.sellRequirementFeeRate * 4 ** priceExponent)
  const multiplier = modifiers.intelligenceCenter === 3 ? 1 - 0.3 * (1 + modifiers.hideoutManagement / 100) : 1
  const fee = Math.round(raw * multiplier)
  const net = gross - fee
  if (!Number.isSafeInteger(fee) || fee < 0 || !Number.isSafeInteger(net)) return null
  return { gross, fee, net }
}

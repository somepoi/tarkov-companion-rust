import type { TraderPrice } from '../api/types'

/**
 * Whether the current character can actually buy a catalog trader offer.
 *
 * A `buyFromTrader` entry is only a catalog quote. Buying it also depends on the
 * character's loyalty level, the offer's unlock quest and the remaining units
 * per restock. Loyalty and unlocks gate the purchase entirely; the purchase
 * limit only bounds how many units one restock allows.
 *
 * Anything not positively established stays explicit: an unrecorded loyalty
 * level, an unfinished unlock quest or a malformed limit never becomes a
 * claimed purchase price or an invented profit.
 */
export interface AccessibleOffer {
  kind: 'available'
  /** The offer that can actually be bought, not merely the cheapest quote. */
  offer: TraderPrice
  priceRUB: number
  /** Units one restock certainly allows; 1 when the catalog limit is unknown. */
  unitsPerRestock: number
  /** False when the catalog publishes no usable purchase limit. */
  limitKnown: boolean
}

export type TraderOfferAccess = AccessibleOffer | { kind: 'unknown'; reason: string }

export interface TraderAccessFacts {
  /** Loyalty level the player recorded for this mode, per trader id. Absent = unknown. */
  levels: Record<string, number>
  /** Quest ids the profile counts as completed, used for offer unlock quests. */
  completedTaskIds: ReadonlySet<string>
}

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export const NO_ACCESS = (reason: string): TraderOfferAccess => ({ kind: 'unknown', reason })

/** Highest loyalty the game defines; anything above is malformed, not superior. */
const MAX_LOYALTY = 8

/** Judge one offer on its own. Callers that hold every offer should use
 * `bestTraderOffer`, which considers alternatives the character can reach. */
export function traderOfferAccess(
  offer: TraderPrice | undefined,
  facts: TraderAccessFacts,
): TraderOfferAccess {
  if (!offer) return NO_ACCESS('no trader offer is recorded')
  if (!positiveInteger(offer.priceRUB))
    return NO_ACCESS('the trader price is missing or malformed')

  if (offer.minTraderLevel != null) {
    const required = offer.minTraderLevel
    // 0 is the catalog's "no loyalty requirement" value; anything above the
    // game's highest level is malformed, not superior.
    if (!Number.isSafeInteger(required) || required < 0 || required > MAX_LOYALTY)
      return NO_ACCESS('the required loyalty level is malformed')
    if (required > 0) {
      const recorded = facts.levels[offer.traderId]
      if (!Number.isSafeInteger(recorded) || (recorded ?? 0) < 1)
        return NO_ACCESS(
          `record this character's loyalty level for the trader (LL${required} required)`,
        )
      if ((recorded as number) < required)
        return NO_ACCESS(
          `the recorded loyalty LL${recorded} is below the required LL${required}`,
        )
    }
  }

  if (offer.taskUnlock != null && offer.taskUnlock !== '') {
    if (!facts.completedTaskIds.has(offer.taskUnlock))
      return NO_ACCESS('the offer unlock quest is not completed')
  }

  // The catalog documents 0/absent as "unknown". That still permits the normal
  // single-unit purchase, but it cannot justify a larger claim.
  const limit = offer.buyLimit
  if (limit == null || limit === 0) {
    return {
      kind: 'available',
      offer,
      priceRUB: offer.priceRUB,
      unitsPerRestock: 1,
      limitKnown: false,
    }
  }
  if (!positiveInteger(limit))
    return NO_ACCESS('the per-restock purchase limit is malformed')

  return {
    kind: 'available',
    offer,
    priceRUB: offer.priceRUB,
    unitsPerRestock: limit,
    limitKnown: true,
  }
}

/**
 * Cheapest offer the character can actually buy, or an explicit reason why none
 * can be reached.
 *
 * A catalog's cheapest quote is often a higher-loyalty offer. Judging only that
 * one would hide a slightly more expensive offer the character *can* buy, which
 * is just as wrong as promising the unreachable price.
 */
export function bestTraderOffer(
  offers: readonly TraderPrice[] | undefined,
  facts: TraderAccessFacts,
): TraderOfferAccess {
  if (!offers || offers.length === 0) return NO_ACCESS('no trader offer is recorded')
  const reasons: string[] = []
  let best: AccessibleOffer | null = null
  for (const offer of offers) {
    const access = traderOfferAccess(offer, facts)
    if (access.kind === 'unknown') {
      if (!reasons.includes(access.reason)) reasons.push(access.reason)
      continue
    }
    if (!best || access.priceRUB < best.priceRUB) best = access
  }
  if (best) return best
  return NO_ACCESS(reasons.join('; ') || 'no trader offer can be verified')
}

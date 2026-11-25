// Copied from the chat assistant (modules/ai-agent-for-live-chat/lib/shop/) and kept in step
// by hand: the two modules never import each other. Learned on live chats; a
// caller asks the same questions.
import { stockBucket } from './variation-stock'
import { pickVariations } from './variation-match'
import type { StockFacts } from './product-format'

// ---------------------------------------------------------------------------
// What a product search says about a listing sold in variations. Pure, so the
// rules are pinned by tests (lib/shop/search-variations.test.ts).
//
// Learned on a live chat: asked for "the cheapest green office chair", the
// assistant offered one listing (its green out of stock) because only the
// listing's name and blurb were searched, and the green lived in the
// variations' option values ("Myrrh Green"), where the shop's own colour
// filter finds a dozen chairs. Asked again for one in stock, it offered the
// same chair. So a search also reads the variations:
//
//   - the searched words a listing's variations carry (a colour, a size) pick
//     out the variations that fit, and the cheapest of those is quoted with its
//     own price, stock and page, not the listing's range;
//   - "can be bought" means anything but plain out of stock: in stock, low,
//     pre-order, or out of stock but still orderable (made to order);
//   - when only what can be bought is wanted, a listing with no fitting
//     variation that can be bought is left out.
//
// Which variations fit is decided first by the option matcher get_product uses
// (lib/shop/variation-match.ts), so "black frame" binds to the frame and "no
// modesty panel" means without; only when that narrows nothing are the
// attribute labels (a colour family) tried.
// ---------------------------------------------------------------------------

export type SearchVariation = {
  id: string
  /** The option names and values, in the shop's order. */
  optionNames: readonly string[]
  optionValues: readonly string[]
  /** The shop filter's families for each value, in step with optionValues. */
  aliases?: ReadonlyArray<readonly string[]>
  /** Every label the variation carries: option values and the attribute values
   *  stamped on it (a colour family such as "Green & Black"). */
  labels: readonly string[]
  price: number
  facts: StockFacts
}

export type ListingPick<V extends SearchVariation> = {
  /** True when some searched word is carried by this listing's variations. */
  narrowed: boolean
  /** The variations the searched words fit (every one, when none narrow). */
  fitting: V[]
  /** Of those, the ones that can be bought now. */
  buyable: V[]
  /** The cheapest variation to quote: of the buyable fits when any, else of
   *  every fit. Null when nothing fits. */
  cheapest: V | null
}

/** Whether a variation can be bought now: anything but plain out of stock. */
export function canBuy(facts: StockFacts): boolean {
  return stockBucket(facts) !== 'outOfStock'
}

/** Whether one label carries the word under any of its spellings, as a whole
 *  word or the start of one ("green" in "Myrrh Green", "Greenwood" too). */
function labelHas(label: string, variants: readonly string[]): boolean {
  const words = label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return variants.some((variant) => words.some((word) => word === variant || (variant.length >= 4 && word.startsWith(variant))))
}

/** The variations of one listing the searched words fit, and the one to quote.
 *  `words` is each searched word with its spellings, as expandSearchWords gives. */
export function pickForSearch<V extends SearchVariation>(variations: readonly V[], words: readonly (readonly string[])[], query = ''): ListingPick<V> {
  const matched = query
    ? pickVariations(query, variations.map((variation) => ({ optionNames: variation.optionNames, optionValues: variation.optionValues, aliases: variation.aliases, name: '' })))
    : null
  if (matched && !matched.closest && matched.fits.length > 0 && matched.fits.length < variations.length) {
    const fitting = matched.fits.map((index) => variations[index]).filter((variation): variation is V => !!variation)
    const buyable = fitting.filter((variation) => canBuy(variation.facts))
    return { narrowed: true, fitting, buyable, cheapest: cheapestOf(buyable.length > 0 ? buyable : fitting) }
  }
  const carried = words.filter((variants) => variations.some((variation) => variation.labels.some((label) => labelHas(label, variants))))
  const fitting = carried.length === 0
    ? [...variations]
    : variations.filter((variation) => carried.every((variants) => variation.labels.some((label) => labelHas(label, variants))))
  const buyable = fitting.filter((variation) => canBuy(variation.facts))
  return { narrowed: carried.length > 0, fitting, buyable, cheapest: cheapestOf(buyable.length > 0 ? buyable : fitting) }
}

function cheapestOf<V extends SearchVariation>(pool: readonly V[]): V | null {
  return pool.reduce<V | null>((best, variation) => (best === null || variation.price < best.price ? variation : best), null)
}

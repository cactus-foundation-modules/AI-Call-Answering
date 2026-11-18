import { stockSummary, type StockFacts } from './product-format'
import { searchTokens } from './text'

// ---------------------------------------------------------------------------
// Narrowing a listing's variations by the caller's words, and saying which of
// the still-open choices are in stock. Pure, so the matching rules and the
// buckets are pinned by tests (lib/variation-stock.test.ts).
//
// Why it exists: get_product lists only the first few variations that fit. A
// caller asking "which finishes are in stock in 120 by 80 with a black frame?"
// needs an answer across EVERY fit, not the first eight; and words like
// "finish", "frame" or "cm" must not make a match fail just because no option
// label happens to contain them.
// ---------------------------------------------------------------------------

/** Words a caller uses ABOUT an option rather than as one ("the walnut
 *  finish", "120 cm", "which colours are in stock"). Dropped before matching:
 *  each one would otherwise have to appear in a label and would rule out every
 *  variation. Kept narrow on purpose - a word that can be an option value in its
 *  own right (black, high, top) never goes here. */
export const VARIATION_FILLER = new Set([
  'finish', 'finishes', 'frame', 'frames', 'colour', 'colours', 'color', 'colors', 'coloured', 'colored',
  'size', 'sizes', 'cm', 'cms', 'mm', 'centimetre', 'centimetres', 'centimeter', 'centimeters',
  'millimetre', 'millimetres', 'millimeter', 'millimeters', 'by',
  'option', 'options', 'version', 'versions', 'variation', 'variations', 'model', 'style',
  'stock', 'available', 'availability', 'which', 'what', 'have', 'got', 'do', 'does', 'there', 'please',
])

/** The words that narrow the variations: "120x80cm walnut finish" becomes
 *  ["120", "80", "walnut"]. Sizes written as one run ("120x80", "160cm") are
 *  split into their numbers. Empty when only filler was given. */
export function variationWords(wanted: string, limit = 10): string[] {
  const spaced = wanted
    .toLowerCase()
    .replace(/(\d)\s*(?:x|×|\*|by)\s*(?=\d)/g, '$1 ')
    .replace(/(\d)(?:cms?|mm|m)\b/g, '$1')
  return searchTokens(spaced, limit + VARIATION_FILLER.size).filter((word) => !VARIATION_FILLER.has(word)).slice(0, limit)
}

/** What a variation's words are matched against: its option values, the names
 *  of its options (so "black frame" still fits when the option is called
 *  "Frame"), and its own name. */
export function variationHaystack(row: { optionNames: readonly string[]; optionValues: readonly string[]; name: string }): string {
  return `${row.optionValues.join(' / ')} ${row.optionNames.join(' ')} ${row.name}`
}

export type StockBucket = 'inStock' | 'preOrder' | 'outOfStockCanOrder' | 'outOfStock'

/** Which of stockSummary's answers a variation falls under, as a bucket. */
export function stockBucket(facts: StockFacts): StockBucket {
  const words = stockSummary(facts)
  if (words === 'available to pre-order') return 'preOrder'
  if (words === 'out of stock right now') return 'outOfStock'
  if (words.startsWith('out of stock')) return 'outOfStockCanOrder'
  return 'inStock'
}

/** Best first: a value counts as in stock if ANY fitting variation with it is. */
const BUCKET_ORDER: readonly StockBucket[] = ['inStock', 'preOrder', 'outOfStockCanOrder', 'outOfStock']

export type OptionAvailability = {
  option: string
  inStock: string[]
  preOrder: string[]
  outOfStockCanOrder: string[]
  outOfStock: string[]
}

export type FittingVariation = { optionNames: readonly string[]; optionValues: readonly string[]; facts: StockFacts }

/** For each option still open among the fitting variations (more than one value
 *  left), every value sorted into a stock bucket. Names only, in the order the
 *  shop lists them, so it can be spoken. An option the caller has already
 *  settled (one value left) is left out. */
export function summariseStockByOption(fits: readonly FittingVariation[]): OptionAvailability[] {
  const options = new Map<string, Map<string, StockBucket>>()
  for (const fit of fits) {
    const bucket = stockBucket(fit.facts)
    fit.optionNames.forEach((name, index) => {
      const value = fit.optionValues[index]
      if (!value) return
      const values = options.get(name) ?? new Map<string, StockBucket>()
      options.set(name, values)
      const held = values.get(value)
      if (held === undefined || BUCKET_ORDER.indexOf(bucket) < BUCKET_ORDER.indexOf(held)) values.set(value, bucket)
    })
  }
  const summary: OptionAvailability[] = []
  for (const [option, values] of options) {
    if (values.size < 2) continue
    const entry: OptionAvailability = { option, inStock: [], preOrder: [], outOfStockCanOrder: [], outOfStock: [] }
    for (const [value, bucket] of values) entry[bucket].push(value)
    summary.push(entry)
  }
  return summary
}

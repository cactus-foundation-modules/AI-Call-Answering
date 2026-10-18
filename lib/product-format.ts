// Turning shop rows into short facts a voice assistant can state. Pure, so the
// wording of "in stock" and "excluding VAT" is pinned by tests rather than
// scattered through queries.

export type StockFacts = {
  trackInventory: boolean
  stockCount: number | null
  lowStockThreshold: number | null
  outOfStockBehaviour: string | null
  isPreOrder: boolean
}

/** One honest sentence about whether it can be bought now. */
export function stockSummary(facts: StockFacts): string {
  if (facts.isPreOrder) return 'available to pre-order'
  if (!facts.trackInventory) return 'available'
  const count = facts.stockCount ?? 0
  if (count <= 0) {
    return facts.outOfStockBehaviour && facts.outOfStockBehaviour !== 'BLOCK'
      ? 'out of stock right now but can still be ordered'
      : 'out of stock right now'
  }
  if (facts.lowStockThreshold !== null && count <= facts.lowStockThreshold) return 'in stock, but only a few left'
  return 'in stock'
}

export function formatPrice(amount: number, symbol: string): string {
  const fixed = Number.isInteger(amount) ? amount.toFixed(0) : amount.toFixed(2)
  return `${symbol}${fixed}`
}

/** What the listed price means, so the assistant never says "including VAT" of
 *  a shop that keeps its prices net. */
export function priceBasis(taxMode: string): string {
  return taxMode === 'EXCLUSIVE' ? 'excluding VAT' : 'including VAT'
}

/** The price to quote: the sale price when there is a real one below the full price. */
export function effectivePrice(price: number, salePrice: number | null): { now: number; was: number | null } {
  if (salePrice !== null && salePrice > 0 && salePrice < price) return { now: salePrice, was: price }
  return { now: price, was: null }
}

export type PriceRange = { low: number; high: number }

export function describePriceRange(range: PriceRange, symbol: string): string {
  return range.low === range.high
    ? formatPrice(range.low, symbol)
    : `from ${formatPrice(range.low, symbol)} to ${formatPrice(range.high, symbol)}`
}

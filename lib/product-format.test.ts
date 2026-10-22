import { describe, expect, it } from 'vitest'
import { describePriceRange, effectivePrice, formatPrice, priceBasis, quoteQuantity, stockSummary } from './product-format'

const base = { trackInventory: true, stockCount: 10, lowStockThreshold: 3, outOfStockBehaviour: 'BLOCK', isPreOrder: false }

describe('stockSummary', () => {
  it('says available when stock is not tracked', () => {
    expect(stockSummary({ ...base, trackInventory: false })).toBe('available')
  })
  it('covers in stock, low, out and backorder', () => {
    expect(stockSummary(base)).toBe('in stock')
    expect(stockSummary({ ...base, stockCount: 2 })).toBe('in stock, but only a few left')
    expect(stockSummary({ ...base, stockCount: 0 })).toBe('out of stock right now')
    expect(stockSummary({ ...base, stockCount: 0, outOfStockBehaviour: 'ALLOW' })).toBe('out of stock right now but can still be ordered')
  })
  it('puts pre-order first', () => {
    expect(stockSummary({ ...base, isPreOrder: true })).toBe('available to pre-order')
  })
})

describe('prices', () => {
  it('drops pointless pence', () => {
    expect(formatPrice(120, '£')).toBe('£120')
    expect(formatPrice(112.5, '£')).toBe('£112.50')
  })
  it('names the tax basis', () => {
    expect(priceBasis('EXCLUSIVE')).toBe('excluding VAT')
    expect(priceBasis('INCLUSIVE')).toBe('including VAT')
  })
  it('only treats a lower sale price as a sale', () => {
    expect(effectivePrice(100, 80)).toEqual({ now: 80, was: 100 })
    expect(effectivePrice(100, 100)).toEqual({ now: 100, was: null })
    expect(effectivePrice(100, null)).toEqual({ now: 100, was: null })
  })
  it('describes a range', () => {
    expect(describePriceRange({ low: 90, high: 90 }, '£')).toBe('£90')
    expect(describePriceRange({ low: 90, high: 140 }, '£')).toBe('from £90 to £140')
  })
})

describe('quoteQuantity', () => {
  const tracked = { trackInventory: true, stockCount: 50, lowStockThreshold: 5, outOfStockBehaviour: 'BLOCK', isPreOrder: false }
  it('works the total out to the penny', () => {
    expect(quoteQuantity(36, 126, '£', tracked)).toMatchObject({ unitPrice: '£126', total: '£4536', stock: 'enough in stock for 36' })
    expect(quoteQuantity(36, 4.95, '£', tracked).total).toBe('£178.20')
  })
  it('says when stock falls short', () => {
    expect(quoteQuantity(80, 10, '£', tracked).stock).toBe('only 50 in stock, fewer than the 80 asked for')
  })
  it('defers to the plain summary when stock is not tracked', () => {
    expect(quoteQuantity(3, 10, '£', { ...tracked, trackInventory: false }).stock).toBe('available')
  })
})

import { describe, expect, it } from 'vitest'
import { expandSearchWords, textHasWord } from './spelling'
import { stockBucket, summariseStockByOption, variationHaystack, variationWords, type FittingVariation } from './variation-stock'

const inStock = { trackInventory: true, stockCount: 10, lowStockThreshold: 2, outOfStockBehaviour: 'BLOCK', isPreOrder: false }
const fewLeft = { ...inStock, stockCount: 1 }
const out = { ...inStock, stockCount: 0 }
const backorder = { ...out, outOfStockBehaviour: 'ALLOW' }
const preOrder = { ...inStock, isPreOrder: true }

const NAMES = ['Size', 'Depth', 'Finish', 'Frame'] as const
const FINISHES = ['Beech', 'Grey Oak', 'White', 'Walnut', 'Black', 'Oak', 'Maple', 'Concrete', 'Anthracite', 'Cherry', 'Light Grey', 'Sonoma Oak']

/** An Air Lite-style desk: two sizes, two depths, twelve finishes, two frames. */
function desk(): Array<FittingVariation & { name: string }> {
  const rows: Array<FittingVariation & { name: string }> = []
  for (const size of ['120cm', '140cm']) {
    for (const depth of ['60cm', '80cm']) {
      FINISHES.forEach((finish, index) => {
        for (const frame of ['Black', 'White']) {
          const facts = finish === 'Walnut' ? out
            : finish === 'Cherry' ? backorder
              : finish === 'Maple' ? preOrder
                : finish === 'White' && frame === 'Black' && size === '120cm' ? (depth === '80cm' ? fewLeft : out)
                  : index % 2 === 0 ? inStock : out
          rows.push({ name: 'Air Lite desk', optionNames: [...NAMES], optionValues: [size, depth, finish, frame], facts })
        }
      })
    }
  }
  return rows
}

function fitting(rows: ReturnType<typeof desk>, wanted: string) {
  const words = expandSearchWords(variationWords(wanted), null)
  return rows.filter((row) => words.every((variants) => textHasWord(variationHaystack(row), variants)))
}

describe('variationWords', () => {
  it('drops words about an option and splits sizes said as one run', () => {
    expect(variationWords('120x80 cm black frame')).toEqual(['120', '80', 'black'])
    expect(variationWords('120 by 80, walnut finish')).toEqual(['120', '80', 'walnut'])
    expect(variationWords('160cm white colour')).toEqual(['160', 'white'])
    expect(variationWords('which finishes are in stock')).toEqual([])
  })
  it('keeps words that can be option values', () => {
    expect(variationWords('black high back top')).toEqual(['black', 'high', 'back', 'top'])
  })
})

describe('matching a desk by size, depth and frame', () => {
  it('finds every finish for 120 by 80 with a black frame, filler words and all', () => {
    const fits = fitting(desk(), '120x80cm black frame')
    // "black" also matches the Black finish on a white frame: still only that one extra.
    expect(fits.filter((row) => row.optionValues[3] === 'Black')).toHaveLength(FINISHES.length)
    expect(fits.length).toBeGreaterThan(8)
  })
  it('matches a word against the option name too', () => {
    const fits = fitting(desk(), 'grey oak finish 140 60')
    expect(fits.every((row) => row.optionValues[2] === 'Grey Oak')).toBe(true)
    expect(fits).toHaveLength(2)
  })
})

describe('stockBucket', () => {
  it('uses the same buckets as stockSummary', () => {
    expect(stockBucket(inStock)).toBe('inStock')
    expect(stockBucket(fewLeft)).toBe('inStock')
    expect(stockBucket({ ...inStock, trackInventory: false })).toBe('inStock')
    expect(stockBucket(out)).toBe('outOfStock')
    expect(stockBucket(backorder)).toBe('outOfStockCanOrder')
    expect(stockBucket(preOrder)).toBe('preOrder')
  })
})

describe('summariseStockByOption', () => {
  it('puts every finish of more than eight fits in the right bucket', () => {
    const fits = desk().filter((row) => row.optionValues[0] === '120cm' && row.optionValues[1] === '80cm' && row.optionValues[3] === 'Black')
    expect(fits.length).toBe(FINISHES.length)
    const summary = summariseStockByOption(fits)
    // Size, depth and frame are settled, so only finish is left open.
    expect(summary.map((entry) => entry.option)).toEqual(['Finish'])
    const finish = summary[0]!
    expect(finish.inStock).toEqual(['Beech', 'White', 'Black', 'Anthracite', 'Light Grey'])
    expect(finish.outOfStock).toEqual(['Grey Oak', 'Walnut', 'Oak', 'Concrete', 'Sonoma Oak'])
    expect(finish.outOfStockCanOrder).toEqual(['Cherry'])
    expect(finish.preOrder).toEqual(['Maple'])
    const named = [...finish.inStock, ...finish.outOfStock, ...finish.outOfStockCanOrder, ...finish.preOrder]
    expect(named.sort()).toEqual([...FINISHES].sort())
  })
  it('counts a value as in stock when any fitting combination with it is', () => {
    const fits = desk().filter((row) => row.optionValues[0] === '120cm' && row.optionValues[3] === 'Black')
    const summary = summariseStockByOption(fits)
    expect(summary.map((entry) => entry.option)).toEqual(['Depth', 'Finish'])
    const finish = summary.find((entry) => entry.option === 'Finish')!
    // White on a black frame is out at 60 deep but has a few left at 80.
    expect(finish.inStock).toContain('White')
    expect(finish.outOfStock).not.toContain('White')
  })
  it('says nothing when nothing is left open', () => {
    expect(summariseStockByOption(desk().slice(0, 1))).toEqual([])
  })
})

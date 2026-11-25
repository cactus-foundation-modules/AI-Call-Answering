import { describe, expect, it } from 'vitest'
import { canBuy, pickForSearch, type SearchVariation } from './search-variations'

const inStock = { trackInventory: true, stockCount: 5, lowStockThreshold: 1, outOfStockBehaviour: 'BLOCK', isPreOrder: false }
const out = { ...inStock, stockCount: 0 }
const madeToOrder = { ...out, outOfStockBehaviour: 'ALLOW' }

function variation(id: string, colour: string, price: number, facts = inStock, family: string[] = []): SearchVariation {
  return { id, optionNames: ['Colour'], optionValues: [colour], labels: [colour, ...family], price, facts }
}

describe('canBuy', () => {
  it('counts made to order and pre-order as buyable, plain out of stock as not', () => {
    expect(canBuy(inStock)).toBe(true)
    expect(canBuy(madeToOrder)).toBe(true)
    expect(canBuy({ ...inStock, isPreOrder: true })).toBe(true)
    expect(canBuy(out)).toBe(false)
  })
})

describe('pickForSearch', () => {
  const chair = [
    variation('black', 'Black', 110),
    variation('myrrh', 'Myrrh Green', 116, madeToOrder),
    variation('moss', 'Moss Green', 112, out),
  ]

  it('finds a colour in the option values and quotes the cheapest that can be bought', () => {
    const pick = pickForSearch(chair, [['green']])
    expect(pick.narrowed).toBe(true)
    expect(pick.fitting.map((v) => v.id)).toEqual(['myrrh', 'moss'])
    expect(pick.buyable.map((v) => v.id)).toEqual(['myrrh'])
    expect(pick.cheapest?.id).toBe('myrrh')
  })

  it('falls back to the cheapest fit when none can be bought, so the caller can leave it out', () => {
    const rowan = [variation('green', 'Myrrh Green', 138, out), variation('blue', 'Blue', 130)]
    const pick = pickForSearch(rowan, [['green']])
    expect(pick.buyable).toEqual([])
    expect(pick.cheapest?.id).toBe('green')
  })

  it('narrows on attribute labels such as a colour family', () => {
    const rows = [variation('a', 'Palm', 90, inStock, ['Green & Black']), variation('b', 'Navy', 80)]
    expect(pickForSearch(rows, [['green']]).fitting.map((v) => v.id)).toEqual(['a'])
  })

  it('leaves every variation in when no searched word is about them', () => {
    const pick = pickForSearch(chair, [['office'], ['chair', 'chairs']])
    expect(pick.narrowed).toBe(false)
    expect(pick.fitting).toHaveLength(3)
    expect(pick.cheapest?.id).toBe('black')
  })

  it('does not take "red" from "Reduced" or "tan" from "Tango"', () => {
    const rows = [variation('a', 'Reduced Height', 90), variation('b', 'Tango', 80), variation('c', 'Red', 99)]
    expect(pickForSearch(rows, [['red']]).fitting.map((v) => v.id)).toEqual(['c'])
    expect(pickForSearch(rows, [['tan']]).fitting.map((v) => v.id)).toEqual(['a', 'b', 'c'])
  })

  it('uses the option matcher first, so a colour binds to the option it names', () => {
    const desk = (id: string, finish: string, frame: string, price: number): SearchVariation => ({
      id, optionNames: ['Finish', 'Frame Colour'], optionValues: [finish, frame], labels: [finish, frame], price, facts: inStock,
    })
    const rows = [desk('ww', 'White', 'White', 300), desk('wb', 'White', 'Black', 310), desk('bb', 'Black', 'Black', 320)]
    const pick = pickForSearch(rows, [['black'], ['frame']], 'white top black frame')
    expect(pick.fitting.map((v) => v.id)).toEqual(['wb'])
  })
})

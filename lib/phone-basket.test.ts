import { describe, expect, it } from 'vitest'
import { MAX_LINE_QUANTITY, basketUrl, normaliseBasketItems } from './phone-basket'

describe('normaliseBasketItems', () => {
  it('merges repeats of one product and drops nonsense', () => {
    expect(normaliseBasketItems([
      { product_id: 'a', quantity: 10 },
      { product_id: ' a ', quantity: 5.7 },
      { product_id: 'b', quantity: 0 },
      { product_id: '', quantity: 3 },
    ])).toEqual([{ productId: 'a', quantity: 15 }])
  })

  it('caps a runaway quantity', () => {
    expect(normaliseBasketItems([{ product_id: 'a', quantity: 1e9 }])[0]!.quantity).toBe(MAX_LINE_QUANTITY)
  })
})

describe('basketUrl', () => {
  it('points at the public restore route', () => {
    expect(basketUrl('abc_DEF-123', 'https://shop.test')).toBe('https://shop.test/api/m/ai-call-answering/public/basket?t=abc_DEF-123')
  })
})

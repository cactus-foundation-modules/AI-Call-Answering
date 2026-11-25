import { describe, expect, it } from 'vitest'
import {
  MAX_DISCUSSED_PRODUCTS,
  fromProductDetail,
  fromSkuHits,
  parseDiscussedProducts,
  productsToSend,
  rememberProducts,
  type DiscussedProduct,
} from './discussed-products'

// What a call remembers it was about, and what a note lists from it.

const desk: DiscussedProduct = { id: 'desk', parentId: null }
const deskBlack: DiscussedProduct = { id: 'desk-black', parentId: 'desk' }
const chair: DiscussedProduct = { id: 'chair', parentId: null }

describe('what the product tools record', () => {
  it('get_product: the one variation that matched, else the product itself', () => {
    expect(fromProductDetail({ id: 'desk', matchingVariations: [{ id: 'desk-black' }] })).toEqual([deskBlack])
    expect(fromProductDetail({ id: 'desk', matchingVariations: null })).toEqual([desk])
    expect(fromProductDetail({ id: 'desk', matchingVariations: [{ id: 'a' }, { id: 'b' }] })).toEqual([desk])
  })

  it('find_by_sku: the one hit, or the one exact hit, never a guess among several', () => {
    const variation = { productId: 'desk', match: 'exact' as const, variation: { id: 'desk-black' } }
    const close = { productId: 'chair', match: 'close' as const, variation: null }
    expect(fromSkuHits([variation])).toEqual([deskBlack])
    expect(fromSkuHits([variation, close])).toEqual([deskBlack])
    expect(fromSkuHits([close])).toEqual([chair])
    expect(fromSkuHits([close, { ...close, productId: 'stool' }])).toEqual([])
    expect(fromSkuHits([])).toEqual([])
  })
})

describe('rememberProducts', () => {
  it('keeps the newest last, moving a repeat to the end', () => {
    expect(rememberProducts([desk, chair], [desk]).map((p) => p.id)).toEqual(['chair', 'desk'])
  })

  it('lets a chosen variation replace its listing', () => {
    expect(rememberProducts([desk, chair], [deskBlack]).map((p) => p.id)).toEqual(['chair', 'desk-black'])
  })

  it('brings the chosen variation forward when its listing is read again', () => {
    expect(rememberProducts([deskBlack, chair], [desk]).map((p) => p.id)).toEqual(['chair', 'desk-black'])
  })

  it('keeps only the newest ten', () => {
    const many = Array.from({ length: MAX_DISCUSSED_PRODUCTS + 4 }, (_, i) => ({ id: `p${i}`, parentId: null }))
    const kept = rememberProducts([], many)
    expect(kept).toHaveLength(MAX_DISCUSSED_PRODUCTS)
    expect(kept[kept.length - 1]?.id).toBe(`p${MAX_DISCUSSED_PRODUCTS + 3}`)
  })
})

describe('parseDiscussedProducts', () => {
  it('reads the stored list and drops anything without an id', () => {
    expect(parseDiscussedProducts([{ id: 'desk' }, { parentId: 'x' }, 'chair', null, { id: ' ' }])).toEqual([desk])
    expect(parseDiscussedProducts({})).toEqual([])
    expect(parseDiscussedProducts(null)).toEqual([])
  })
})

describe('productsToSend (the chat assistant\'s live-site bug: a note with no products)', () => {
  it('falls back to the call\'s own record, newest first, when the model passes none', () => {
    expect(productsToSend([], [chair, deskBlack], 5)).toEqual(['desk-black', 'chair'])
  })

  it('uses the ids the model passed when it passed any', () => {
    expect(productsToSend(['chair'], [chair, deskBlack], 5)).toEqual(['chair'])
  })

  it('swaps a listing the model named for the variation the call settled on', () => {
    expect(productsToSend(['desk', 'chair'], [deskBlack, chair], 5)).toEqual(['desk-black', 'chair'])
  })

  it('never lists more than asked, never twice, and nothing when nothing was discussed', () => {
    expect(productsToSend([], [desk, chair, deskBlack], 1)).toEqual(['desk-black'])
    expect(productsToSend(['chair', 'chair', ' '], [], 5)).toEqual(['chair'])
    expect(productsToSend([], [], 5)).toEqual([])
  })
})

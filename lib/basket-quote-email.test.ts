import { beforeAll, describe, expect, it } from 'vitest'
import { basketParagraph, productsForSummary } from './call-email'
import type { CallBasket } from './phone-basket'

const basket = (quote: CallBasket['quote']): CallBasket => ({
  token: 'tok_abcdefghijklmnop',
  lines: [{ productId: 'chair-black', quantity: 4 }, { productId: 'desk-oak', quantity: 2 }],
  quote,
  quotesSaved: quote ? 1 : 0,
})

const emailed = { id: 'q1', number: 'QUO-1042', url: 'https://shop.test/quote/AB3XY9', emailed: true }

describe('the summary email once a quote has gone', () => {
  beforeAll(() => { process.env.SITE_URL ??= 'https://shop.test' })

  it('links the phone basket when no quote was saved', () => {
    expect(basketParagraph(basket(null))).toContain('/api/m/ai-call-answering/public/basket?t=tok_abcdefghijklmnop')
  })

  it('leaves the basket out entirely when the quote was emailed', () => {
    expect(basketParagraph(basket(emailed))).toBe('')
  })

  it('links the quote, not the basket, when it was saved but not emailed', () => {
    const html = basketParagraph(basket({ ...emailed, emailed: false }))
    expect(html).toContain('https://shop.test/quote/AB3XY9')
    expect(html).toContain('QUO-1042')
    expect(html).not.toContain('public/basket')
  })

  it('drops the quoted products from the listing once emailed, and keeps the rest', () => {
    expect(productsForSummary(['chair-black', 'lamp', 'desk-oak'], basket(emailed))).toEqual(['lamp'])
  })

  it('keeps every product while nothing has been emailed', () => {
    expect(productsForSummary(['chair-black', 'lamp'], basket({ ...emailed, emailed: false }))).toEqual(['chair-black', 'lamp'])
    expect(productsForSummary(['chair-black'], null)).toEqual(['chair-black'])
  })
})

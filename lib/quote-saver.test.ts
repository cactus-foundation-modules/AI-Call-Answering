import { beforeEach, describe, expect, it, vi } from 'vitest'

const points: Record<string, Record<string, unknown>> = {}
vi.mock('@/lib/modules/extension-points.server', () => ({ moduleServerExtensionPointComponents: points }))

const { quotesAvailable, saveQuote, BASKET_QUOTE_SAVER_POINT } = await import('./quote-saver')

const input = { lines: [{ productId: 'p1', quantity: 2 }], customerName: 'Jo Bloggs', customerEmail: 'jo@example.test', customerPhone: '', staffNotes: '' }

beforeEach(() => {
  for (const key of Object.keys(points)) delete points[key]
})

describe('saving a phone basket as a quote', () => {
  it('reports no quotes and saves nothing when no module publishes a saver', async () => {
    expect(await quotesAvailable()).toBe(false)
    expect(await saveQuote(input)).toBeNull()
  })

  it('follows the saver\'s own on/off switch', async () => {
    points[BASKET_QUOTE_SAVER_POINT] = { quotes: { canSave: async () => false, save: async () => ({}) } }
    expect(await quotesAvailable()).toBe(false)
  })

  it('treats a saver that throws on canSave as unavailable', async () => {
    points[BASKET_QUOTE_SAVER_POINT] = { quotes: { canSave: async () => { throw new Error('db down') }, save: async () => ({}) } }
    expect(await quotesAvailable()).toBe(false)
  })

  it('passes the lines through and reads back a saved quote', async () => {
    const save = vi.fn(async () => ({
      ok: true,
      quote: { id: 'q1', quoteNumber: 'QUO-7', code: 'AB3-XY9', url: 'https://shop.test/quote/AB3XY9', expiresAt: null },
      emailedCustomer: true,
      unavailable: [],
      record: { anything: 'the saver keeps for itself' },
    }))
    points[BASKET_QUOTE_SAVER_POINT] = { quotes: { canSave: async () => true, save } }
    expect(await quotesAvailable()).toBe(true)
    const result = await saveQuote(input)
    expect(save).toHaveBeenCalledWith(input)
    expect(result).toMatchObject({ ok: true, emailedCustomer: true, quote: { quoteNumber: 'QUO-7' } })
  })

  it('passes a refusal on in the saver\'s words', async () => {
    points[BASKET_QUOTE_SAVER_POINT] = { quotes: { canSave: async () => true, save: async () => ({ ok: false, reason: 'disabled', message: 'Switched off.' }) } }
    expect(await saveQuote(input)).toEqual({ ok: false, message: 'Switched off.' })
  })

  it('never trusts an answer in the wrong shape', async () => {
    points[BASKET_QUOTE_SAVER_POINT] = { quotes: { canSave: async () => true, save: async () => ({ ok: true, quote: 'QUO-7' }) } }
    expect(await saveQuote(input)).toEqual({ ok: false, message: 'The quote could not be saved.' })
  })

  it('ignores something at the point that is not a saver', async () => {
    points[BASKET_QUOTE_SAVER_POINT] = { junk: () => null }
    expect(await saveQuote(input)).toBeNull()
  })
})

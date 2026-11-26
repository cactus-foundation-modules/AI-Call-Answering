import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CallRecord } from './calls'

// A note of the call lists the products the call was about even when the
// model passes none, and greets the caller in proper case.

type Ref = { moduleName: string; kind: string; id: string }
const products = vi.hoisted(() => ({
  real: new Set<string>(),
  resolveProducts: vi.fn(async (refs: Ref[]) => refs.filter((ref) => products.real.has(ref.id)).map((ref) => ({ choice: ref }))),
}))
const mail = vi.hoisted(() => ({ sendTemplateEmail: vi.fn(async () => true) }))

vi.mock('@/lib/email', () => mail)
vi.mock('@/modules/unified-inbox/lib/products', () => ({ resolveProducts: products.resolveProducts }))
vi.mock('@/modules/unified-inbox/lib/products/render', () => ({ renderProductTable: (choices: Ref[]) => choices.map((c) => `[${c.id}]`).join('') }))
vi.mock('./calls', () => ({ recentEmailsFrom: vi.fn(async () => 0), recordEmailSent: vi.fn(async () => undefined), saveDiscussedProducts: vi.fn(async () => undefined) }))
vi.mock('./product-queries', () => ({ toProductRefs: async (ids: string[]) => ids.map((id) => ({ moduleName: 'shop', kind: 'product', id })), variationIdsOf: async () => [] }))
vi.mock('./phone-basket', () => ({ basketUrl: (token: string) => `https://shop.test/basket/${token}`, getCallBasket: vi.fn(async () => null) }))
vi.mock('./settings', () => ({ getSettings: async () => ({ extraInstructions: '', emailSignature: '' }) }))
vi.mock('./order-queries', () => ({ emailsOnOrders: vi.fn(async () => []), nameOnOrderEmail: vi.fn(async () => '') }))
vi.mock('./delivery-choice', () => ({ matchService: vi.fn(), timingMenus: vi.fn(async () => new Map()) }))
vi.mock('./site-content', () => ({ sendableLinks: async () => new Map() }))

const { emailCallSummary, linkWithDelivery } = await import('./call-email')

function call(over: Partial<CallRecord> = {}): CallRecord {
  return {
    id: 'call-1', callSid: 'CA1', conversationId: null, fromNumber: '+447700900123', toNumber: '+441234567890',
    status: 'in_progress', startedAt: new Date('2026-11-25T10:00:00Z'), durationSeconds: 0, summary: '', transcript: [],
    callerName: '', callerEmail: '', callerPhone: '', callbackNeeded: false, callbackReason: '', handledAt: null, readAt: null,
    verifiedOrders: [], verifiedContact: { name: '', email: '', phone: '' }, failedOrderChecks: 0, emailsSent: 0, emailedTo: '',
    toolLog: [], discussedProducts: [], updatedAt: new Date('2026-11-25T10:00:00Z'),
    ...over,
  }
}

const input = { email: 'jo@example.com', name: null, subject: 'Desks', summary: 'About desks.', productIds: [] as string[], linkIds: [], deliveries: [] }
const vars = () => (mail.sendTemplateEmail.mock.calls[0] as unknown as [string, string, Record<string, string>])[2]
const deskBlack = { id: 'desk-black', url: null, parentId: 'desk' }
const chair = { id: 'chair', url: null, parentId: null }

beforeEach(() => {
  vi.clearAllMocks()
  products.real = new Set(['desk', 'desk-black', 'chair'])
})

describe('emailCallSummary lists the products the call was about', () => {
  it('falls back to the call\'s recorded products, newest first, when the model passes none', async () => {
    expect(await emailCallSummary(call({ discussedProducts: [chair, deskBlack] }), input)).toMatchObject({ ok: true })
    expect(vars()).toMatchObject({ productsHtml: '[desk-black][chair]', hasProducts: 'true' })
  })

  it('uses the ids passed, swapping a listing for the variation chosen', async () => {
    await emailCallSummary(call({ discussedProducts: [chair, deskBlack] }), { ...input, productIds: ['desk'] })
    expect(vars().productsHtml).toBe('[desk-black]')
  })

  it('falls back to the record when no id passed is a product the shop can show', async () => {
    await emailCallSummary(call({ discussedProducts: [chair] }), { ...input, productIds: ['made-up-id'] })
    expect(vars().productsHtml).toBe('[chair]')
  })

  it('lists nothing when nothing was discussed', async () => {
    await emailCallSummary(call(), input)
    expect(vars()).toMatchObject({ productsHtml: '', hasProducts: '' })
  })

  it('greets the caller in proper case', async () => {
    await emailCallSummary(call({ callerName: 'chris' }), input)
    expect(vars().customerName).toBe('Chris')
    vi.clearAllMocks()
    await emailCallSummary(call(), { ...input, name: "MARY-JANE O'NEIL" })
    expect(vars().customerName).toBe("Mary-Jane O'Neil")
  })
})

describe('linkWithDelivery (the live-site express link)', () => {
  it('puts the chosen service on the product link, and leaves others alone', () => {
    const choice = { url: 'https://shop.test/desk?width=140cm', deliveryQuote: { key: 'express-delivery' } } as unknown as Parameters<typeof linkWithDelivery>[0]
    expect(linkWithDelivery(choice).url).toBe('https://shop.test/desk?width=140cm&delivery-service=express-delivery')
    const plain = { url: 'https://shop.test/chair', deliveryQuote: null } as unknown as Parameters<typeof linkWithDelivery>[0]
    expect(linkWithDelivery(plain).url).toBe('https://shop.test/chair')
  })
})

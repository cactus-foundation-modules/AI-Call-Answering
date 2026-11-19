import { beforeEach, describe, expect, it, vi } from 'vitest'

const shop = vi.hoisted(() => ({
  submitOrderRequest: vi.fn(),
  addOrderNote: vi.fn(),
  getOrderByNumber: vi.fn(),
  loadOrderDetail: vi.fn(),
}))

vi.mock('@/modules/shop/lib/order-request-actions', () => ({ submitOrderRequest: shop.submitOrderRequest }))
vi.mock('@/modules/shop/lib/db/orders', () => ({ addOrderNote: shop.addOrderNote, getOrderByNumber: shop.getOrderByNumber }))
vi.mock('@/modules/shop/lib/member-orders', () => ({ loadOrderDetail: shop.loadOrderDetail }))
vi.mock('./calls', () => ({ callerLabel: () => '+447700900123' }))

import { DEFAULT_PHOTO_NOTE, matchLine, matchLines, raiseOrderRequest, type LineChoice } from './order-request-tool'
import type { CallRecord } from './calls'

const desk: LineChoice = { orderItemId: 'i1', name: 'Air Lite Height Adjustable Desk', available: 2 }
const chair: LineChoice = { orderItemId: 'i2', name: 'Prism Mesh Chair', available: 4 }
const pedestal: LineChoice = { orderItemId: 'i3', name: 'Mobile Pedestal', available: 0 }
const skus = new Map([['i1', 'AL-1280-BK'], ['i2', 'PRISM-BLK'], ['i3', 'PED-3']])

describe('matchLine', () => {
  it('finds a line by product code, ignoring case', () => {
    expect(matchLine('prism-blk', [desk, chair], skus)?.orderItemId).toBe('i2')
  })
  it('finds a line by a few words of its name', () => {
    expect(matchLine('the desk', [desk, chair], skus)?.orderItemId).toBe('i1')
    expect(matchLine('mesh chair', [desk, chair], skus)?.orderItemId).toBe('i2')
  })
  it('refuses to guess when nothing fits', () => {
    expect(matchLine('sofa', [desk, chair], skus)).toBeNull()
  })
})

describe('matchLines', () => {
  const opts = { missingReport: false, wholeOrderAllowed: false }

  it('takes the only line of a one-item order without being told', () => {
    expect(matchLines([], [desk, pedestal], skus, opts)).toEqual({ ok: true, lines: [{ orderItemId: 'i1', quantity: 2, missing: null }] })
  })
  it('asks which item when there are several, naming only those it can cover', () => {
    const out = matchLines([], [desk, chair, pedestal], skus, opts)
    expect(out.ok).toBe(false)
    if (!out.ok) {
      expect(out.message).toContain('Prism Mesh Chair')
      expect(out.message).not.toContain('Pedestal')
    }
  })
  it('lets a cancellation name nothing (the whole order)', () => {
    expect(matchLines([], [desk, chair], skus, { ...opts, wholeOrderAllowed: true })).toEqual({ ok: true, lines: [] })
  })
  it('refuses more than the line can cover', () => {
    const out = matchLines([{ item: 'chair', quantity: 5, missing: null }], [desk, chair], skus, opts)
    expect(out.ok).toBe(false)
  })
  it('defaults to every unit of the line', () => {
    expect(matchLines([{ item: 'chair', quantity: null, missing: null }], [desk, chair], skus, opts))
      .toEqual({ ok: true, lines: [{ orderItemId: 'i2', quantity: 4, missing: null }] })
  })
  it('needs whole-or-parts on a missing report', () => {
    const missing = { missingReport: true, wholeOrderAllowed: false }
    expect(matchLines([{ item: 'desk', quantity: 1, missing: null }], [desk], skus, missing).ok).toBe(false)
    expect(matchLines([{ item: 'desk', quantity: 1, missing: 'parts' }], [desk], skus, missing))
      .toEqual({ ok: true, lines: [{ orderItemId: 'i1', quantity: 1, missing: 'PARTS' }] })
  })
})

describe('raiseOrderRequest', () => {
  const call = { id: 'c1', verifiedOrders: ['DW000290'], callerName: '', fromNumber: '+447700900123' } as unknown as CallRecord
  const allowed = { allowed: true }
  const detail = {
    cancel: allowed,
    return: allowed,
    damage: allowed,
    lines: [
      { item: { id: 'i1', productName: 'Air Lite Height Adjustable Desk', productSku: 'AL-1280-BK', quantity: 1, refundedQty: 0 }, cancellableQty: 0, returnableQty: 1 },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    shop.getOrderByNumber.mockResolvedValue({ id: 'o290', memberId: null, orderNumber: 'DW000290' })
    shop.loadOrderDetail.mockResolvedValue(detail)
    shop.submitOrderRequest.mockResolvedValue({ ok: true, request: { id: 'r1' } })
    shop.addOrderNote.mockResolvedValue(undefined)
  })

  it('asks the customer for photographs when damage is reported', async () => {
    const out = await raiseOrderRequest(call, { kind: 'issue', reason: 'ARRIVED_DAMAGED', orderNumber: '290', items: [], whatHappened: 'Split in the desk top', photoNote: null })
    expect(out).toMatchObject({ ok: true, raised: true, photosRequested: true })
    const [input, opts] = shop.submitOrderRequest.mock.calls[0]!
    expect(input).toMatchObject({ orderId: 'o290', type: 'DAMAGE', reason: 'ARRIVED_DAMAGED', customerNote: 'Split in the desk top', items: [{ orderItemId: 'i1', quantity: 1, missing: null }] })
    expect(opts).toEqual({ notifyCustomer: true, alertShop: true, photoRequest: { note: DEFAULT_PHOTO_NOTE, userId: null } })
  })

  it('asks for photographs of a fault too, with what the caller described', async () => {
    await raiseOrderRequest(call, { kind: 'issue', reason: 'FAULTY', orderNumber: null, items: [{ item: 'desk', quantity: null, missing: null }], whatHappened: 'Motor stopped', photoNote: 'the control panel' })
    expect(shop.submitOrderRequest.mock.calls[0]![1].photoRequest).toEqual({ note: 'the control panel', userId: null })
  })

  it('does not ask for photographs of something missing, or of a return', async () => {
    await raiseOrderRequest(call, { kind: 'issue', reason: 'MISSING', orderNumber: null, items: [{ item: 'desk', quantity: 1, missing: 'whole' }], whatHappened: null, photoNote: null })
    await raiseOrderRequest(call, { kind: 'return', reason: 'NO_LONGER_NEEDED', orderNumber: null, items: [], whatHappened: null, photoNote: null })
    expect(shop.submitOrderRequest.mock.calls.map((c) => c[1].photoRequest)).toEqual([null, null])
  })

  it('touches only an order verified this call', async () => {
    const out = await raiseOrderRequest(call, { kind: 'return', reason: 'NO_LONGER_NEEDED', orderNumber: '168', items: [], whatHappened: null, photoNote: null })
    expect(out.ok).toBe(false)
    expect(shop.submitOrderRequest).not.toHaveBeenCalled()
  })

  it('passes on the shop refusing it, and raises nothing', async () => {
    shop.loadOrderDetail.mockResolvedValue({ ...detail, return: { allowed: false, reason: 'The returns window has closed.' } })
    const out = await raiseOrderRequest(call, { kind: 'return', reason: 'NO_LONGER_NEEDED', orderNumber: null, items: [], whatHappened: null, photoNote: null })
    expect(out).toMatchObject({ ok: false, raised: false, refusedBecause: 'The returns window has closed.' })
    expect(shop.submitOrderRequest).not.toHaveBeenCalled()
  })

  it('refuses a reason the shop does not take, listing the ones it does', async () => {
    const out = await raiseOrderRequest(call, { kind: 'return', reason: 'ARRIVED_DAMAGED', orderNumber: null, items: [], whatHappened: null, photoNote: null })
    expect(out.ok).toBe(false)
    expect(String(out.message)).toContain('NO_LONGER_NEEDED')
  })
})

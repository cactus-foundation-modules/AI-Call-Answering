import { describe, expect, it } from 'vitest'
import { claimMatchesOrder, isCheckableClaim, orderStatusWords, trackingStageWords, type OrderIdentity } from './order-verify'

const order: OrderIdentity = {
  orderNumber: 'DW-1042',
  customerEmail: 'Jo.Bloggs@Example.com',
  customerOrganisation: 'Bloggs & Co Ltd',
  shippingPostcode: 'SW1A 1AA',
  shippingCompany: null,
}

const claim = { postcode: 'sw1a1aa', orderNumber: null, email: null, companyName: null }

describe('isCheckableClaim', () => {
  it('needs a postcode AND an identifier', () => {
    expect(isCheckableClaim({ ...claim, orderNumber: 'DW1042' })).toBe(true)
    expect(isCheckableClaim(claim)).toBe(false)
    expect(isCheckableClaim({ ...claim, postcode: '', orderNumber: 'DW1042' })).toBe(false)
    expect(isCheckableClaim({ ...claim, postcode: 'ab', orderNumber: 'DW1042' })).toBe(false)
  })
})

describe('claimMatchesOrder', () => {
  it('matches on order number and postcode however they are spelt', () => {
    expect(claimMatchesOrder({ ...claim, orderNumber: 'dw 1042' }, order)).toBe(true)
  })
  it('matches on email, ignoring case', () => {
    expect(claimMatchesOrder({ ...claim, email: 'jo.bloggs@example.com' }, order)).toBe(true)
  })
  it('matches on company name, ignoring punctuation and suffix', () => {
    expect(claimMatchesOrder({ ...claim, companyName: 'bloggs and co limited' }, order)).toBe(true)
  })
  it('refuses a right order number with the wrong postcode', () => {
    expect(claimMatchesOrder({ ...claim, postcode: 'EC1A 1BB', orderNumber: 'DW1042' }, order)).toBe(false)
  })
  it('refuses a right postcode with no identifier', () => {
    expect(claimMatchesOrder(claim, order)).toBe(false)
  })
  it('requires every detail given to match', () => {
    expect(claimMatchesOrder({ ...claim, orderNumber: 'DW1042', email: 'someone@else.com' }, order)).toBe(false)
  })
  it('refuses an order with no recorded postcode', () => {
    expect(claimMatchesOrder({ ...claim, orderNumber: 'DW1042' }, { ...order, shippingPostcode: null })).toBe(false)
  })
  it('does not let an empty company name match an empty record', () => {
    expect(claimMatchesOrder({ ...claim, companyName: 'Ltd' }, { ...order, customerOrganisation: 'Limited' })).toBe(false)
  })
})

describe('wording', () => {
  it('describes statuses', () => {
    expect(orderStatusWords('SHIPPED', 'PAID')).toBe('dispatched')
    expect(orderStatusWords('PENDING', 'PENDING')).toBe('received, waiting for payment to clear')
    expect(orderStatusWords('WEIRD_NEW', 'PAID')).toBe('weird new')
  })
  it('humanises stages', () => {
    expect(trackingStageWords('OUT_FOR_DELIVERY')).toBe('out for delivery')
    expect(trackingStageWords(null)).toBeNull()
  })
})

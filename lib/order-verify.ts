import { normaliseCompany, normaliseOrderNumber, normalisePostcode } from './text'

// Proving who is calling before anything about an order is said.
//
// The rule, in one place: the delivery postcode is ALWAYS required, together
// with at least one of order number, email or company name, and every detail
// the caller does give must match. A caller who knows an order number but not
// the postcode gets nothing, because order numbers are printed on parcels and
// emails that get forwarded and photographed; a postcode alone is a guess. It
// takes both.

export type OrderClaim = {
  postcode: string
  orderNumber: string | null
  email: string | null
  companyName: string | null
}

/** The parts of an order that can be checked against a claim. */
export type OrderIdentity = {
  orderNumber: string
  customerEmail: string
  customerOrganisation: string | null
  shippingPostcode: string | null
  shippingCompany: string | null
}

/** Whether a claim carries enough to be worth checking at all. */
export function isCheckableClaim(claim: OrderClaim): boolean {
  if (normalisePostcode(claim.postcode).length < 5) return false
  return !!(claim.orderNumber?.trim() || claim.email?.trim() || claim.companyName?.trim())
}

export function claimMatchesOrder(claim: OrderClaim, order: OrderIdentity): boolean {
  if (!isCheckableClaim(claim)) return false
  if (!order.shippingPostcode) return false
  if (normalisePostcode(claim.postcode) !== normalisePostcode(order.shippingPostcode)) return false

  if (claim.orderNumber?.trim()) {
    if (normaliseOrderNumber(claim.orderNumber) !== normaliseOrderNumber(order.orderNumber)) return false
  }
  if (claim.email?.trim()) {
    if (claim.email.trim().toLowerCase() !== order.customerEmail.trim().toLowerCase()) return false
  }
  if (claim.companyName?.trim()) {
    const spoken = normaliseCompany(claim.companyName)
    if (spoken === '') return false
    const held = [order.customerOrganisation, order.shippingCompany]
      .filter((name): name is string => !!name)
      .map(normaliseCompany)
    if (!held.includes(spoken)) return false
  }
  return true
}

/** Plain words for where an order stands. */
export function orderStatusWords(status: string, paymentStatus: string): string {
  switch (status) {
    case 'PENDING':
      return paymentStatus === 'PAID' ? 'received and being confirmed' : 'received, waiting for payment to clear'
    case 'PROCESSING':
      return 'being processed'
    case 'PREPARING':
      return 'being prepared for dispatch'
    case 'SHIPPED':
      return 'dispatched and on its way'
    case 'COMPLETED':
      return 'completed'
    case 'CANCELLED':
      return 'cancelled'
    case 'REFUNDED':
      return 'refunded'
    case 'PARTIALLY_REFUNDED':
      return 'partly refunded'
    case 'ON_HOLD':
      return 'on hold'
    default:
      return status.toLowerCase().replace(/_/g, ' ')
  }
}

/** A courier's stage code in words a caller can be told. Unknown codes are
 *  passed through readable rather than hidden. */
export function trackingStageWords(stage: string | null): string | null {
  if (!stage) return null
  return stage.toLowerCase().replace(/[_-]+/g, ' ').trim() || null
}

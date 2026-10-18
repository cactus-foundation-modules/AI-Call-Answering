import { sendTemplateEmail } from '@/lib/email'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { orderUrlVars } from '@/modules/shop/lib/email'
import { orderTrackingUrl } from '@/modules/shop/lib/order-tracking'
import type { CallRecord } from './calls'
import { normaliseOrderNumber } from './text'

// ---------------------------------------------------------------------------
// Emailing a caller the link to their order page.
//
// The security is in what is NOT a parameter. The address is the one on the
// order the caller proved they own, taken from the call record, so a caller
// (or a model talked into it) cannot point the email somewhere else. The order
// is one the caller verified this call, nothing else.
// ---------------------------------------------------------------------------

/** The verified order to send, or null when the caller asked for one they did
 *  not verify, or did not say which and there is more than one. */
export function pickOrderForLink(verifiedOrders: string[], requested: string | null): string | null {
  if (requested?.trim()) {
    const wanted = normaliseOrderNumber(requested)
    return verifiedOrders.find((number) => normaliseOrderNumber(number) === wanted) ?? null
  }
  return verifiedOrders.length === 1 ? (verifiedOrders[0] ?? null) : null
}

export type OrderLinkOutcome = { ok: true } | { ok: false; message: string }

export async function emailOrderLink(call: CallRecord, requested: string | null): Promise<OrderLinkOutcome> {
  if (call.verifiedOrders.length === 0) {
    return { ok: false, message: 'No order has been checked on this call yet. Check the order first, or offer a callback.' }
  }
  const email = call.verifiedContact.email.trim()
  if (!email) {
    return { ok: false, message: 'There is no email address on that order, so the link cannot be sent. Offer a callback instead.' }
  }
  const orderNumber = pickOrderForLink(call.verifiedOrders, requested)
  if (!orderNumber) {
    return { ok: false, message: 'Which order do they mean? Ask the caller for the order number, then try again.' }
  }

  const config = await getShopConfigCached()
  const url = orderTrackingUrl(orderNumber, config)
  if (!url) {
    return { ok: false, message: 'Order links are not switched on for this shop, so none can be emailed. Offer a callback instead.' }
  }

  const sent = await sendTemplateEmail(email, 'ai-call-answering.order-link', {
    customerName: call.verifiedContact.name || 'there',
    orderNumber,
    ...orderUrlVars(url, config),
  })
  if (!sent) return { ok: false, message: 'The email could not be sent just now. Offer a callback instead.' }
  return { ok: true }
}

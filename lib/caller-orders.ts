import { orderNumbersMatch } from './text'

// ---------------------------------------------------------------------------
// What lookup_caller_orders tells the model. Pure, so the privacy rules are
// pinned by tests (lib/caller-orders.test.ts) rather than left to a prompt.
//
// The rule: the caller's phone number recognises them, but it must never be
// used to read out orders they did not ask about. A number can be shared (an
// office line, a household) or recycled, so the list behind it may hold
// somebody else's orders. So:
// - given an order number, only that order is looked up; if it is not on this
//   number the model hears "not on this number" and nothing about the rest;
// - without one, the list is for matching what the caller DESCRIBED, never for
//   reading out or hinting at.
// ---------------------------------------------------------------------------

/** The newest order on the caller's number that is the one they named, as a
 *  one-item list of its id, or an empty list. Rows arrive newest first. */
export function pickOrderOnNumber(rows: ReadonlyArray<{ id: string; order_number: string }>, spoken: string): string[] {
  const match = rows.find((row) => orderNumbersMatch(spoken, row.order_number))
  return match ? [match.id] : []
}

export type CallerOrdersReplyInput = {
  /** The order number the caller gave, or null when they gave none. */
  orderNumber: string | null
  matched: boolean
  orderCount: number
  contactOnFile: boolean
}

const NEVER_HINT = 'Never mention, list or hint at any other order on this number, or that there are others: not its date, its items or how many there are.'

/** The words for the model when nothing (or not the named order) was found. */
export function callerOrdersMissMessage(orderNumber: string | null): string {
  return orderNumber
    ? `Order ${orderNumber} is not one placed from the number this caller rang from. Say nothing about that, and nothing about any other order. Check it the normal way with lookup_order: pass this order number and ask for the delivery postcode. ${NEVER_HINT}`
    : 'No order is linked to the number this caller rang from. Say nothing about that to the caller. Carry on with the normal check using lookup_order: ask for the delivery postcode and the order number, email or company name.'
}

/** The note that goes with orders found on the caller's number. */
export function callerOrdersNote(input: Omit<CallerOrdersReplyInput, 'matched'>): string {
  const which = input.orderNumber
    ? `This is order ${input.orderNumber}, the one the caller asked about, and it was placed from the number they rang from, so it is verified: do NOT ask for a postcode, email or company name. Talk about this order only. ${NEVER_HINT}`
    : input.orderCount > 1
      ? `These are the orders on the number the caller rang from, newest first, and they are for MATCHING ONLY. Do not read them out, do not say how many there are and do not offer one up ("I can see one from January"). If the caller has not yet said which order they mean, ask them to describe it - roughly when they placed it, or what was in it - and then talk only about the one order that fits what they said, using placedMonth, placedWords and items to match. If more than one fits, ask another question about their order; never describe one they did not mention. If none fits, say you cannot find it from their number and use lookup_order instead. ${NEVER_HINT}`
      : `This is the one order on the number the caller rang from. Speak about it only if it fits what the caller described (when they ordered, what was in it); if they have not described it yet, ask first. If it does not fit, do not mention it: use lookup_order instead. ${NEVER_HINT}`
  return [
    which,
    'If the caller says it is about an order that is not this one (for example one placed by a colleague, or under another number), use lookup_order and the normal check instead.',
    input.contactOnFile
      ? 'Their name, email and phone are already on the order: for a callback call save_callback with just the reason.'
      : 'The order has no usable contact details, so a callback will need the caller\'s name and email.',
  ].join(' ')
}

import { addOrderNote, getOrderByNumber } from '@/modules/shop/lib/db/orders'
import { loadOrderDetail, type MemberOrderLine } from '@/modules/shop/lib/member-orders'
import { submitOrderRequest } from '@/modules/shop/lib/order-request-actions'
import { issueKindOf, isValidReason, reasonsFor } from '@/modules/shop/lib/order-requests'
import type { ShpOrderRequestType } from '@/modules/shop/lib/types'
import { callerLabel, type CallRecord } from './calls'
import { orderNumbersMatch } from './text'
import type { ToolResult } from './tool-handlers'

// ---------------------------------------------------------------------------
// Raising a cancellation, a return or an issue report for the caller.
//
// The assistant files exactly what the customer could have filed themselves on
// their order page, through the shop's own recording path, so it is checked the
// same way: the shop's rules for what may be asked for online (the returns
// window, the switches), and the lines checked against the order so nothing is
// called off that has gone and nothing reported that has not arrived. Only an
// order the caller proved is theirs this call can be touched.
//
// The customer gets the shop's usual "we have your request" email, and the shop
// its usual new-request alert: nobody at the shop was on the call. An issue
// report about damage always asks for photographs as it is raised, so that same
// email asks the customer for them, with the link to add them; the caller is
// never sent off to fill the form in themselves.
// ---------------------------------------------------------------------------

export type RequestKind = 'cancel' | 'return' | 'issue'

const SHOP_TYPE: Record<RequestKind, ShpOrderRequestType> = {
  cancel: 'CANCEL',
  return: 'RETURN',
  issue: 'DAMAGE',
}

const KIND_WORD: Record<RequestKind, string> = {
  cancel: 'cancellation',
  return: 'return',
  issue: 'issue report',
}

/** What is asked for when a damage report is raised and the assistant was not
 *  told anything more particular. */
export const DEFAULT_PHOTO_NOTE =
  'Please send us photographs of the damage, and of the packaging too if that was damaged.'

export type RequestedLine = { item: string; quantity: number | null; missing: 'whole' | 'parts' | null }

export type LineChoice = { orderItemId: string; name: string; available: number }

export type MatchedLines =
  | { ok: true; lines: Array<{ orderItemId: string; quantity: number; missing: 'WHOLE' | 'PARTS' | null }> }
  | { ok: false; message: string }

function words(value: string): string[] {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
}

/** The order line the caller means: an exact product code, else the one line
 *  whose name holds every word they used, else the one line that holds most of
 *  them. Null when nothing fits or two lines fit as well as each other. */
export function matchLine(said: string, lines: readonly LineChoice[], skus: ReadonlyMap<string, string>): LineChoice | null {
  const wanted = said.trim().toLowerCase()
  if (!wanted) return null
  const bySku = lines.filter((line) => (skus.get(line.orderItemId) ?? '').toLowerCase() === wanted)
  if (bySku.length === 1) return bySku[0] ?? null

  const saidWords = words(said)
  if (saidWords.length === 0) return null
  const scored = lines.map((line) => {
    const nameWords = new Set(words(`${line.name} ${skus.get(line.orderItemId) ?? ''}`))
    return { line, hits: saidWords.filter((word) => nameWords.has(word)).length }
  })
  const best = Math.max(...scored.map((entry) => entry.hits))
  if (best === 0) return null
  const top = scored.filter((entry) => entry.hits === best)
  return top.length === 1 ? (top[0]?.line ?? null) : null
}

/** Turns the lines the caller named into the shop's own lines, or a sentence
 *  the assistant can act on. An order of one line needs no naming. */
export function matchLines(
  requested: readonly RequestedLine[],
  choices: readonly LineChoice[],
  skus: ReadonlyMap<string, string>,
  opts: { missingReport: boolean; wholeOrderAllowed: boolean },
): MatchedLines {
  const open = choices.filter((choice) => choice.available > 0)
  const names = open.map((choice) => choice.name).join('; ')
  if (requested.length === 0) {
    if (opts.wholeOrderAllowed) return { ok: true, lines: [] }
    if (open.length === 1 && !opts.missingReport) {
      const only = open[0]!
      return { ok: true, lines: [{ orderItemId: only.orderItemId, quantity: only.available, missing: null }] }
    }
    return { ok: false, message: `Which item is it about? Ask the caller, then pass it in items. The items it can cover: ${names || 'none'}.` }
  }

  const lines: Array<{ orderItemId: string; quantity: number; missing: 'WHOLE' | 'PARTS' | null }> = []
  for (const entry of requested) {
    const line = matchLine(entry.item, open, skus)
    if (!line) {
      return { ok: false, message: `"${entry.item}" does not match one item this can cover. Ask the caller which they mean. The items it can cover: ${names || 'none'}.` }
    }
    const quantity = entry.quantity ?? line.available
    if (quantity > line.available) {
      return { ok: false, message: `Only ${line.available} of the ${line.name} can be included. Check the number with the caller.` }
    }
    if (opts.missingReport && !entry.missing) {
      return { ok: false, message: `For the ${line.name}, ask whether all of it is missing or just some parts, then pass missing as whole or parts.` }
    }
    lines.push({
      orderItemId: line.orderItemId,
      quantity,
      missing: opts.missingReport ? (entry.missing === 'parts' ? 'PARTS' : 'WHOLE') : null,
    })
  }
  return { ok: true, lines }
}

/** Units of a line that a request of this kind can still name. An issue report
 *  covers what has arrived - and since the caller is believed when they say it
 *  has arrived, anything on the order that has not been refunded. */
function availableUnits(line: MemberOrderLine, kind: RequestKind): number {
  if (kind === 'cancel') return line.cancellableQty
  if (kind === 'return') return line.returnableQty
  return Math.max(line.item.quantity - line.item.refundedQty, 0)
}

/** The verified order the caller means: the one whose number they said (with
 *  or without the prefix and padding zeros), or the only one verified. Never an
 *  order they did not prove this call. */
export function pickVerifiedOrder(verifiedOrders: readonly string[], requested: string | null): string | null {
  if (requested?.trim()) return verifiedOrders.find((held) => orderNumbersMatch(requested, held)) ?? null
  return verifiedOrders.length === 1 ? (verifiedOrders[0] ?? null) : null
}

export type RaiseInput = {
  kind: RequestKind
  reason: string
  orderNumber: string | null
  items: RequestedLine[]
  whatHappened: string | null
  photoNote: string | null
}

export async function raiseOrderRequest(call: CallRecord, input: RaiseInput): Promise<ToolResult> {
  if (call.verifiedOrders.length === 0) {
    return { ok: false, message: 'No order has been checked on this call yet. Check the order first (see CHECKING WHO IS CALLING), then try again.' }
  }
  const orderNumber = pickVerifiedOrder(call.verifiedOrders, input.orderNumber)
  if (!orderNumber) {
    return { ok: false, message: 'Which order is it about? Ask the caller for the order number, then try again.' }
  }

  const type = SHOP_TYPE[input.kind]
  if (!isValidReason(type, input.reason)) {
    const codes = reasonsFor(type).map((reason) => `${reason.code} (${reason.label})`).join(', ')
    return { ok: false, message: `That is not a reason the shop takes for a ${KIND_WORD[input.kind]}. Pick the closest of: ${codes}.` }
  }
  const issueKind = type === 'DAMAGE' ? issueKindOf(input.reason) : null
  const whatHappened = input.whatHappened?.trim() || null
  if (issueKind === 'OTHER' && !whatHappened) {
    return { ok: false, message: 'Ask the caller what is wrong, in a sentence, and pass it in what_happened.' }
  }
  if (issueKind === 'MISSING' && !whatHappened && input.items.some((item) => item.missing === 'parts')) {
    return { ok: false, message: 'Ask the caller which parts are missing and pass it in what_happened, so the right ones can be sent.' }
  }

  const order = await getOrderByNumber(orderNumber)
  const detail = order ? await loadOrderDetail(order.id) : null
  if (!order || !detail) return { ok: false, message: 'That order could not be opened just now. Offer a callback instead.' }

  const eligibility = type === 'CANCEL' ? detail.cancel : type === 'DAMAGE' ? detail.damage : detail.return
  if (!eligibility.allowed) {
    return {
      ok: false,
      raised: false,
      refusedBecause: eligibility.reason,
      message: `Nothing was raised: the shop does not take this as a ${KIND_WORD[input.kind]} on this order (reason above). Tell the caller kindly, in your own words, and offer a callback so the team can look at it.`,
    }
  }

  const choices: LineChoice[] = detail.lines.map((line) => ({
    orderItemId: line.item.id,
    name: line.item.productName,
    available: availableUnits(line, input.kind),
  }))
  const skus = new Map(detail.lines.map((line) => [line.item.id, line.item.productSku ?? '']))
  const matched = matchLines(input.items, choices, skus, {
    missingReport: issueKind === 'MISSING',
    // A cancellation naming nothing is the whole order, which the shop allows
    // only while none of it has gone; it says so itself if not.
    wholeOrderAllowed: type === 'CANCEL',
  })
  if (!matched.ok) return { ok: false, raised: false, message: matched.message }

  // Damage means photographs, always, and a fault the same: the team cannot
  // decide on either without seeing it. Missing items cannot be photographed.
  const askForPhotos = issueKind === 'DAMAGE'
  const photoNote = askForPhotos ? input.photoNote?.trim() || DEFAULT_PHOTO_NOTE : null

  const outcome = await submitOrderRequest(
    {
      orderId: order.id,
      memberId: order.memberId,
      type,
      reason: input.reason,
      customerNote: whatHappened,
      items: matched.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity, missing: line.missing })),
    },
    {
      notifyCustomer: true,
      alertShop: true,
      photoRequest: askForPhotos ? { note: photoNote, userId: null } : null,
    },
  )
  if (!outcome.ok) {
    return { ok: false, raised: false, message: `Nothing was raised: ${outcome.error} Tell the caller in your own words, and offer a callback if it cannot be put right on the call.` }
  }

  // The trail on the order: a request the customer did not type, from a call
  // the team was not on.
  await addOrderNote(
    order.id,
    `${KIND_WORD[input.kind][0]!.toUpperCase()}${KIND_WORD[input.kind].slice(1)} raised by the phone assistant during a call from ${callerLabel(call)}.${askForPhotos ? ' The customer was asked for photographs.' : ''}`,
    true,
    null,
  ).catch((error) => console.error('[ai-call-answering] order note failed', error))

  return {
    ok: true,
    raised: true,
    photosRequested: askForPhotos,
    message: [
      `The ${KIND_WORD[input.kind]} is raised on order ${orderNumber}. The customer is being emailed to confirm it, at the address on the order.`,
      askForPhotos
        ? 'That email asks them for photographs of the damage, with a link to add them to the report. Tell the caller that, and that the team will look at it once the photos are in.'
        : 'Tell the caller the team will look at it and be in touch.',
      'Do not promise a refund, a replacement or a time.',
    ].join(' '),
  }
}

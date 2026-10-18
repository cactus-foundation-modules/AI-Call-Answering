import { z } from 'zod'
import { upsertAlert } from '@/lib/notifications/alerts'
import {
  findCall,
  linkConversation,
  recentFailedChecksFrom,
  recordCallback,
  recordFailedOrderCheck,
  recordVerifiedContact,
  recordVerifiedOrder,
  callerLabel,
  type CallRecord,
} from './calls'
import { lookupOrders } from './order-queries'
import { emailOrderLink } from './order-link'
import { emailCallSummary, MAX_PRODUCTS_PER_EMAIL } from './call-email'
import { isCheckableClaim } from './order-verify'
import { lookupFaqs } from './faq-queries'
import { getProductDetail, listTopCategories, searchProducts } from './product-queries'
import { isPlausibleEmail } from './text'
import type { ToolName } from './agent-config'

// ---------------------------------------------------------------------------
// What each tool does when the assistant calls it.
//
// Every handler returns a plain object that becomes the tool result the model
// reads. Problems the model can recover from (a vague search, an email that did
// not parse) come back as `{ ok: false, message }` with a 200, because a 4xx
// makes ElevenLabs report the tool as broken and the assistant goes quiet; the
// model should be told in words what to say or ask next.
// ---------------------------------------------------------------------------

/** Wrong order checks allowed in one call, and from one number in an hour. */
export const MAX_FAILED_CHECKS_PER_CALL = 3
export const MAX_FAILED_CHECKS_PER_NUMBER_PER_HOUR = 6

const CallIdentity = z.object({
  call_sid: z.string().max(100).optional(),
  conversation_id: z.string().max(200).optional(),
})

const SearchInput = CallIdentity.extend({
  query: z.string().trim().min(1).max(200),
  max_price: z.number().positive().max(1_000_000).optional(),
})
const ProductInput = CallIdentity.extend({
  product_id: z.string().trim().min(1).max(100),
  options: z.string().trim().max(200).optional(),
})
const NoInput = CallIdentity
const FaqInput = CallIdentity.extend({
  category: z.string().trim().max(200).optional(),
  collection: z.string().trim().max(200).optional(),
  query: z.string().trim().max(200).optional(),
})
const OrderInput = CallIdentity.extend({
  delivery_postcode: z.string().trim().max(20).default(''),
  order_number: z.string().trim().max(60).optional(),
  email: z.string().trim().max(320).optional(),
  company_name: z.string().trim().max(160).optional(),
})
const OrderLinkInput = CallIdentity.extend({ order_number: z.string().trim().max(60).optional() })
const SummaryInput = CallIdentity.extend({
  email: z.string().trim().max(320).optional(),
  name: z.string().trim().max(120).optional(),
  subject: z.string().trim().max(200).optional(),
  summary: z.string().trim().min(1).max(4000),
  product_ids: z.array(z.string().trim().min(1).max(100)).max(MAX_PRODUCTS_PER_EMAIL * 2).optional(),
})
const CallbackInput = CallIdentity.extend({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  reason: z.string().trim().min(1).max(1000),
})

export type ToolResult = Record<string, unknown>

/** A tool's answer, plus the callback it saved (if it saved one) so the route
 *  can raise the notification once the response has gone. */
export type ToolOutcome = { result: ToolResult; callbackSaved: CallRecord | null }

const BAD_INPUT: ToolResult = { ok: false, message: 'That request was missing something. Ask the caller again and retry.' }

async function resolveCall(identity: z.infer<typeof CallIdentity>): Promise<CallRecord | null> {
  const call = await findCall({ callSid: identity.call_sid, conversationId: identity.conversation_id })
  if (call && identity.conversation_id && !call.conversationId) {
    await linkConversation(call.id, identity.conversation_id)
  }
  return call
}

function blankToNull(value: string | undefined): string | null {
  return value && value.trim() !== '' ? value.trim() : null
}

async function runOrderLookup(input: z.infer<typeof OrderInput>): Promise<ToolResult> {
  const call = await resolveCall(input)
  if (!call) return { ok: false, message: 'Order checks only work on a live phone call. Offer a callback instead.' }

  const lockedByCall = call.failedOrderChecks >= MAX_FAILED_CHECKS_PER_CALL
  const lockedByNumber = (await recentFailedChecksFrom(call.fromNumber)) >= MAX_FAILED_CHECKS_PER_NUMBER_PER_HOUR
  if (lockedByCall || lockedByNumber) {
    return { ok: false, locked: true, message: 'Too many unmatched attempts. Do not try again. Offer to take a message for a callback.' }
  }

  const claim = {
    postcode: input.delivery_postcode,
    orderNumber: blankToNull(input.order_number),
    email: blankToNull(input.email),
    companyName: blankToNull(input.company_name),
  }
  if (!isCheckableClaim(claim)) {
    return {
      ok: false,
      message: 'To check an order I need the delivery postcode and one of: the order number, the email address on the order, or the company name. Ask for what is missing.',
    }
  }

  const outcome = await lookupOrders(claim)
  if (!outcome.matched) {
    await recordFailedOrderCheck(call.id)
    return { ok: false, matched: false, message: 'No order matches those details. Ask them to double-check and try once more. Do not say which part was wrong.' }
  }
  for (const orderNumber of outcome.internalNumbers) await recordVerifiedOrder(call.id, orderNumber)
  await recordVerifiedContact(call.id, outcome.contact)
  const contactOnFile = !!outcome.contact && outcome.contact.email !== ''
  return {
    ok: true,
    matched: true,
    orders: outcome.orders,
    contactOnFile,
    note: contactOnFile
      ? 'This caller\'s name, email and phone number are already on the order. If you need to arrange a callback, do not ask for them again: call save_callback with just the reason.'
      : 'The order has no usable contact details, so a callback will need the caller\'s name and email.',
  }
}

async function runEmailOrderLink(input: z.infer<typeof OrderLinkInput>): Promise<ToolResult> {
  const call = await resolveCall(input)
  if (!call) return { ok: false, message: 'Emailing a link only works on a live phone call. Offer a callback instead.' }
  try {
    const outcome = await emailOrderLink(call, blankToNull(input.order_number))
    if (!outcome.ok) return outcome
    return { ok: true, message: 'Sent to the email address on the order. Tell the caller it is on its way and may take a minute or two, and to check their junk folder if it does not appear. Do not read the address out.' }
  } catch {
    // A failed send must not leave the assistant silent on a live call.
    return { ok: false, message: 'The email could not be sent just now. Offer a callback instead.' }
  }
}

async function runEmailSummary(input: z.infer<typeof SummaryInput>): Promise<ToolResult> {
  const call = await resolveCall(input)
  if (!call) return { ok: false, message: 'Emailing a summary only works on a live phone call. Offer a callback instead.' }
  try {
    const outcome = await emailCallSummary(call, {
      email: blankToNull(input.email),
      name: blankToNull(input.name),
      subject: input.subject,
      summary: input.summary,
      productIds: input.product_ids ?? [],
    })
    if (!outcome.ok) return outcome
    return { ok: true, message: 'Sent. Tell the caller it is on its way and may take a minute or two, and to check their junk folder if it does not appear. Do not read the address out.' }
  } catch {
    // A failed send must not leave the assistant silent on a live call.
    return { ok: false, message: 'The email could not be sent just now. Offer a callback instead.' }
  }
}

/** A number worth ringing back: the one on the verified order, else the one
 *  the caller rang from if it is a real number rather than withheld. */
function callbackPhone(call: CallRecord, given: string | undefined): string {
  if (given?.trim()) return given.trim()
  if (call.verifiedContact.phone) return call.verifiedContact.phone
  return /^\+\d{6,}$/.test(call.fromNumber) ? call.fromNumber : ''
}

async function runSaveCallback(input: z.infer<typeof CallbackInput>): Promise<ToolOutcome> {
  const call = await resolveCall(input)
  if (!call) {
    return { result: { ok: false, message: 'There is no live call to attach that to. Say somebody will be in touch only if you are sure; otherwise apologise.' }, callbackSaved: null }
  }
  // Details the caller proved by verifying an order are the order's own. A name
  // or email given aloud wins when there is one (they may want a different
  // address), but none is needed when the order already holds them.
  const name = blankToNull(input.name) ?? blankToNull(call.verifiedContact.name)
  const email = blankToNull(input.email) ?? blankToNull(call.verifiedContact.email)
  if (!name) {
    return { result: { ok: false, message: 'I still need the caller\'s full name for the callback. Ask for it and retry.' }, callbackSaved: null }
  }
  if (!email || !isPlausibleEmail(email)) {
    const message = input.email
      ? 'That email address does not look right. Ask them to say it again slowly, read it back, and retry.'
      : 'I still need an email address for the callback. Ask for it, read it back, and retry.'
    return { result: { ok: false, message }, callbackSaved: null }
  }
  await recordCallback(call.id, { name, email: email.toLowerCase(), phone: callbackPhone(call, input.phone), reason: input.reason })
  const saved = await findCall({ callSid: call.callSid })
  return { result: { ok: true, message: 'Saved. Tell the caller somebody will be in touch as soon as they can. Do not promise a time.' }, callbackSaved: saved }
}

/** Raises the admin notification for a saved callback. Called after the tool's
 *  response has gone, so the caller is never kept waiting on it. */
export async function announceCallback(call: CallRecord): Promise<void> {
  await upsertAlert({
    type: 'message',
    dedupeKey: `ai-call-answering:callback:${call.id}`,
    title: `Callback requested by ${callerLabel(call)}`,
    link: '/config?tab=ai-call-answering&sub=calls',
  })
}

export async function runTool(name: ToolName, body: unknown): Promise<ToolOutcome> {
  switch (name) {
    case 'search_products': {
      const input = SearchInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const { products, note } = await searchProducts(input.data.query, input.data.max_price ?? null)
      return { result: { ok: true, products, note }, callbackSaved: null }
    }
    case 'get_product': {
      const input = ProductInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const detail = await getProductDetail(input.data.product_id, blankToNull(input.data.options))
      return {
        result: detail
          ? { ok: true, product: detail }
          : { ok: false, message: 'That product could not be found. Search again.' },
        callbackSaved: null,
      }
    }
    case 'list_categories': {
      if (!NoInput.safeParse(body).success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: { ok: true, categories: await listTopCategories() }, callbackSaved: null }
    }
    case 'get_faqs': {
      const input = FaqInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const outcome = await lookupFaqs({
        category: blankToNull(input.data.category),
        collection: blankToNull(input.data.collection),
        query: blankToNull(input.data.query),
      })
      return { result: outcome, callbackSaved: null }
    }
    case 'lookup_order': {
      const input = OrderInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: await runOrderLookup(input.data), callbackSaved: null }
    }
    case 'email_order_link': {
      const input = OrderLinkInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: await runEmailOrderLink(input.data), callbackSaved: null }
    }
    case 'email_summary': {
      const input = SummaryInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: await runEmailSummary(input.data), callbackSaved: null }
    }
    case 'save_callback': {
      const input = CallbackInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return runSaveCallback(input.data)
    }
  }
}

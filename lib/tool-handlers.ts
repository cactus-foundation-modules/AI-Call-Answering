import { z } from 'zod'
import { upsertAlert } from '@/lib/notifications/alerts'
import {
  findCall,
  linkConversation,
  recentFailedChecksFrom,
  recordCallback,
  recordFailedOrderCheck,
  recordVerifiedOrder,
  callerLabel,
  type CallRecord,
} from './calls'
import { lookupOrders } from './order-queries'
import { isCheckableClaim } from './order-verify'
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
const ProductInput = CallIdentity.extend({ product_id: z.string().trim().min(1).max(100) })
const NoInput = CallIdentity
const OrderInput = CallIdentity.extend({
  delivery_postcode: z.string().trim().max(20).default(''),
  order_number: z.string().trim().max(60).optional(),
  email: z.string().trim().max(320).optional(),
  company_name: z.string().trim().max(160).optional(),
})
const CallbackInput = CallIdentity.extend({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().min(1).max(320),
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
  return { ok: true, matched: true, orders: outcome.orders }
}

async function runSaveCallback(input: z.infer<typeof CallbackInput>): Promise<ToolOutcome> {
  const call = await resolveCall(input)
  if (!call) {
    return { result: { ok: false, message: 'There is no live call to attach that to. Say somebody will be in touch only if you are sure; otherwise apologise.' }, callbackSaved: null }
  }
  if (!isPlausibleEmail(input.email)) {
    return { result: { ok: false, message: 'That email address does not look right. Ask them to say it again slowly, read it back, and retry.' }, callbackSaved: null }
  }
  await recordCallback(call.id, { name: input.name, email: input.email.toLowerCase(), reason: input.reason })
  const saved = await findCall({ callSid: call.callSid })
  return { result: { ok: true, message: 'Saved. Tell the caller somebody will be in touch by email as soon as they can. Do not promise a time.' }, callbackSaved: saved }
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
      const detail = await getProductDetail(input.data.product_id)
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
    case 'lookup_order': {
      const input = OrderInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: await runOrderLookup(input.data), callbackSaved: null }
    }
    case 'save_callback': {
      const input = CallbackInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return runSaveCallback(input.data)
    }
  }
}

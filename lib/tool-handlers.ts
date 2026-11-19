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
import { lookupOrders, lookupOrdersByCallerNumber } from './order-queries'
import { emailOrderLink } from './order-link'
import { callerOrdersMissMessage, callerOrdersNote } from './caller-orders'
import { emailCallSummary, MAX_PRODUCTS_PER_EMAIL } from './call-email'
import { isCheckableClaim } from './order-verify'
import { lookupFaqs } from './faq-queries'
import { paymentInfo } from './payment-queries'
import { findBySku, getProductDetail, listTopCategories, searchProducts } from './product-queries'
import { isPlausibleEmail } from './text'
import { callerHistory } from './caller-history'
import { MAX_BASKET_LINES } from './phone-basket'
import { deliveryToPostcode } from './postcode-delivery'
import { productReviews, searchGuides, searchPages, type Passage } from './site-content'
import { buildBasket, sendText } from './text-tools'
import { saveBasketQuote } from './quote-tool'
import { recordUnanswered } from './unanswered'
import { callerAgreement, notAgreedResult } from './send-consent'
import { raiseOrderRequest } from './order-request-tool'
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
/** Every tool that sends the caller something carries their yes (send-consent.ts).
 *  Optional here so a missing one is answered in words, not as bad input. */
const SendsToCaller = CallIdentity.extend({
  caller_agreed: z.string().max(300).optional(),
})

/** Pages and articles to link: ids from search_pages / search_guides, or an
 *  address from the owner's instructions. Checked against the shop's own links
 *  when sent (site-links.ts). */
const LinkIds = z.array(z.string().trim().min(1).max(600)).max(10).optional()

const SearchInput = CallIdentity.extend({
  query: z.string().trim().min(1).max(200),
  max_price: z.number().positive().max(1_000_000).optional(),
})
const ProductInput = CallIdentity.extend({
  product_id: z.string().trim().min(1).max(100),
  options: z.string().trim().max(200).optional(),
  quantity: z.number().int().positive().max(100_000).optional(),
})
const SkuInput = CallIdentity.extend({
  sku: z.string().trim().min(1).max(80),
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
const CallerOrdersInput = CallIdentity.extend({
  order_number: z.string().trim().max(60).optional(),
})
const OrderLinkInput = SendsToCaller.extend({
  order_number: z.string().trim().max(60).optional(),
  send_to: z.string().trim().max(320).optional(),
})
const SummaryInput = SendsToCaller.extend({
  email: z.string().trim().max(320).optional(),
  name: z.string().trim().max(120).optional(),
  subject: z.string().trim().max(200).optional(),
  summary: z.string().trim().min(1).max(4000),
  product_ids: z.array(z.string().trim().min(1).max(100)).max(MAX_PRODUCTS_PER_EMAIL * 2).optional(),
  link_ids: LinkIds,
  deliveries: z.array(z.object({
    product_id: z.string().trim().min(1).max(100),
    service: z.string().trim().min(1).max(120),
  })).max(MAX_PRODUCTS_PER_EMAIL * 2).optional(),
})
const CallbackInput = CallIdentity.extend({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(40).optional(),
  reason: z.string().trim().min(1).max(1000),
})

const BasketInput = CallIdentity.extend({
  items: z.array(z.object({
    product_id: z.string().trim().min(1).max(100),
    quantity: z.number().positive().max(100_000),
    delivery: z.string().trim().max(120).optional(),
  })).min(1).max(MAX_BASKET_LINES),
})
const QuoteInput = SendsToCaller.extend({
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().max(320).optional(),
})
const TextInput = SendsToCaller.extend({
  what: z.enum(['basket', 'order_link', 'summary']),
  note: z.string().trim().max(1000).optional(),
  product_ids: z.array(z.string().trim().min(1).max(100)).max(6).optional(),
  link_ids: LinkIds,
  order_number: z.string().trim().max(60).optional(),
})
const QueryInput = CallIdentity.extend({
  query: z.string().trim().min(1).max(200),
})
const PostcodeInput = CallIdentity.extend({
  postcode: z.string().trim().min(2).max(20),
  product_id: z.string().trim().max(100).optional(),
})
const ReviewsInput = CallIdentity.extend({
  product_id: z.string().trim().min(1).max(100),
  query: z.string().trim().max(200).optional(),
})
const RaiseRequestInput = CallIdentity.extend({
  kind: z.enum(['cancel', 'return', 'issue']),
  reason: z.string().trim().min(1).max(40),
  order_number: z.string().trim().max(60).optional(),
  items: z.array(z.object({
    item: z.string().trim().min(1).max(200),
    quantity: z.number().int().positive().max(100_000).optional(),
    missing: z.enum(['whole', 'parts']).optional(),
  })).max(50).optional(),
  what_happened: z.string().trim().max(2000).optional(),
  photo_note: z.string().trim().max(1000).optional(),
  // The caller's yes to raising it. Optional here so a missing one is answered
  // in words, not as bad input.
  caller_agreed: z.string().max(300).optional(),
})
const UnansweredInput = CallIdentity.extend({
  question: z.string().trim().min(1).max(300),
  topic: z.string().trim().max(60).optional(),
})

export type ToolResult = Record<string, unknown>

/** What each kind of text is, for asking the caller whether they want it. */
const TEXT_WHAT: Record<z.infer<typeof TextInput>['what'], string> = {
  basket: 'the basket link',
  order_link: 'the link to their order page',
  summary: 'a written note of the call',
}

const LINKS_NOTE =
  'pageLinkId is the page or article itself; links are the links written in that passage (an article it cites, a form). If the caller wants one sent, offer it, and once they say yes pass its id in link_ids to send_text (what "summary") or email_summary. Never read a web address out.'

/** A passage as the model sees it: the words, and link ids with their labels.
 *  The addresses stay here; the send tools look them up again by id. */
function spokenPassage(passage: Passage): Record<string, unknown> {
  return {
    source: passage.source,
    heading: passage.heading,
    text: passage.text,
    ...(passage.page ? { pageLinkId: passage.page.id } : {}),
    ...(passage.links ? { links: passage.links.map((link) => ({ id: link.id, label: link.label })) } : {}),
  }
}

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

/** The addresses on the matched orders, handed over only when there is a choice
 *  to put to the caller. With one address the assistant never needs to see it. */
function emailsOnFile(emails: readonly string[]): ToolResult {
  return emails.length > 1
    ? { emailsOnFile: emails, emailNote: 'These orders carry different email addresses. Whenever an email is to be sent, read each address out naturally (do not spell it letter by letter) and ask which one they want it sent to.' }
    : {}
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
    ...emailsOnFile(outcome.emails),
    note: contactOnFile
      ? 'This caller\'s name, email and phone number are already on the order. If you need to arrange a callback, do not ask for them again: call save_callback with just the reason.'
      : 'The order has no usable contact details, so a callback will need the caller\'s name and email.',
  }
}

/** Orders for the number the caller rang from, with nothing asked of them. A
 *  miss is not a failed check (nobody guessed anything), so it never counts
 *  towards the lock. The caller is told only what a verified lookup would say. */
async function runCallerOrderLookup(input: z.infer<typeof CallerOrdersInput>): Promise<ToolResult> {
  const call = await resolveCall(input)
  if (!call) return { ok: false, message: 'Order checks only work on a live phone call. Offer a callback instead.' }

  const orderNumber = blankToNull(input.order_number)
  const outcome = await lookupOrdersByCallerNumber(call.fromNumber, orderNumber)
  if (!outcome.matched) return { ok: true, matched: false, message: callerOrdersMissMessage(orderNumber) }
  for (const verified of outcome.internalNumbers) await recordVerifiedOrder(call.id, verified)
  await recordVerifiedContact(call.id, outcome.contact)
  const contactOnFile = !!outcome.contact && outcome.contact.email !== ''
  return {
    ok: true,
    matched: true,
    recognisedByPhoneNumber: true,
    orders: outcome.orders,
    contactOnFile,
    ...emailsOnFile(outcome.emails),
    note: callerOrdersNote({ orderNumber, orderCount: outcome.orders.length, contactOnFile }),
  }
}

async function runEmailOrderLink(input: z.infer<typeof OrderLinkInput>): Promise<ToolResult> {
  if (!callerAgreement(input.caller_agreed)) return notAgreedResult('the link to their order page')
  const call = await resolveCall(input)
  if (!call) return { ok: false, message: 'Emailing a link only works on a live phone call. Offer a callback instead.' }
  try {
    const outcome = await emailOrderLink(call, blankToNull(input.order_number), blankToNull(input.send_to))
    if (!outcome.ok) return outcome
    return { ok: true, message: 'Sent to the email address on the order. Tell the caller it is on its way and may take a minute or two, and to check their junk folder if it does not appear. Do not read the address out.' }
  } catch {
    // A failed send must not leave the assistant silent on a live call.
    return { ok: false, message: 'The email could not be sent just now. Offer a callback instead.' }
  }
}

async function runEmailSummary(input: z.infer<typeof SummaryInput>): Promise<ToolResult> {
  if (!callerAgreement(input.caller_agreed)) return notAgreedResult('a written note of the call')
  const call = await resolveCall(input)
  if (!call) return { ok: false, message: 'Emailing a summary only works on a live phone call. Offer a callback instead.' }
  try {
    const outcome = await emailCallSummary(call, {
      email: blankToNull(input.email),
      name: blankToNull(input.name),
      subject: input.subject,
      summary: input.summary,
      productIds: input.product_ids ?? [],
      linkIds: input.link_ids ?? [],
      deliveries: (input.deliveries ?? []).map((entry) => ({ productId: entry.product_id, service: entry.service })),
    })
    if (!outcome.ok) return outcome
    return { ok: true, message: ['Sent. Tell the caller it is on its way and may take a minute or two, and to check their junk folder if it does not appear. Do not read the address out.', outcome.message ?? ''].filter(Boolean).join(' ') }
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
    case 'find_by_sku': {
      const input = SkuInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const { hits, note } = await findBySku(input.data.sku)
      return { result: { ok: true, products: hits, note }, callbackSaved: null }
    }
    case 'get_product': {
      const input = ProductInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const detail = await getProductDetail(input.data.product_id, blankToNull(input.data.options), input.data.quantity ?? null)
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
    case 'get_payment_info': {
      if (!NoInput.safeParse(body).success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: await paymentInfo(), callbackSaved: null }
    }
    case 'lookup_order': {
      const input = OrderInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: await runOrderLookup(input.data), callbackSaved: null }
    }
    case 'lookup_caller_orders': {
      const input = CallerOrdersInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: await runCallerOrderLookup(input.data), callbackSaved: null }
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
    case 'build_basket': {
      const input = BasketInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const call = await resolveCall(input.data)
      if (!call) return { result: { ok: false, message: 'Baskets only work on a live phone call.' }, callbackSaved: null }
      return { result: await buildBasket(call, input.data.items), callbackSaved: null }
    }
    case 'save_quote': {
      const input = QuoteInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      if (!callerAgreement(input.data.caller_agreed)) return { result: notAgreedResult('the basket as a quote by email'), callbackSaved: null }
      const call = await resolveCall(input.data)
      if (!call) return { result: { ok: false, message: 'Quotes only work on a live phone call.' }, callbackSaved: null }
      const result = await saveBasketQuote(call, { name: blankToNull(input.data.name), email: blankToNull(input.data.email) })
      return { result, callbackSaved: null }
    }
    case 'send_text': {
      const input = TextInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      if (!callerAgreement(input.data.caller_agreed)) return { result: notAgreedResult(TEXT_WHAT[input.data.what]), callbackSaved: null }
      const call = await resolveCall(input.data)
      if (!call) return { result: { ok: false, message: 'Texts only work on a live phone call. Offer to email it instead.' }, callbackSaved: null }
      const result = await sendText(call, {
        what: input.data.what,
        note: blankToNull(input.data.note),
        productIds: input.data.product_ids ?? [],
        linkIds: input.data.link_ids ?? [],
        orderNumber: blankToNull(input.data.order_number),
      })
      return { result, callbackSaved: null }
    }
    case 'get_caller_history': {
      const input = NoInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const call = await resolveCall(input.data)
      if (!call) return { result: { ok: false, message: 'History only works on a live phone call.' }, callbackSaved: null }
      const history = await callerHistory(call)
      const empty = history.items.length === 0 && history.openRequests.length === 0
      return {
        result: {
          ok: true,
          ...history,
          note: empty
            ? 'Nothing earlier is linked to this number. Do not tell the caller that; ask them what it was about, and if it was about an order, check the order as usual.'
            : 'Use this to recognise what they mean. Do not read the list out, and do not promise anything somebody else may have said.',
        },
        callbackSaved: null,
      }
    }
    case 'search_pages': {
      const input = QueryInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const { passages, pages } = await searchPages(input.data.query)
      return {
        result: passages.length > 0
          ? { ok: true, passages: passages.map(spokenPassage), note: `Answer from these words only, briefly, and say which page it is on. If none of them answers the question, say you cannot see it and call note_unanswered. ${LINKS_NOTE}` }
          : { ok: false, pages, message: 'Nothing on the shop\'s pages matches that. Try other words once, or say you cannot see it and call note_unanswered.' },
        callbackSaved: null,
      }
    }
    case 'check_delivery_postcode': {
      const input = PostcodeInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      return { result: await deliveryToPostcode(input.data.postcode, blankToNull(input.data.product_id)), callbackSaved: null }
    }
    case 'get_reviews': {
      const input = ReviewsInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const digest = await productReviews(input.data.product_id, blankToNull(input.data.query))
      if (!digest) return { result: { ok: false, message: 'This shop does not collect reviews. Say so if asked, and offer what the product page says instead.' }, callbackSaved: null }
      return {
        result: digest.count === 0
          ? { ok: true, count: 0, message: 'Nobody has reviewed this one yet. Say so plainly; do not offer an opinion of your own.' }
          : { ok: true, ...digest, note: 'Say how many reviews and the average out of five, then paraphrase one or two that answer the question. Never invent or exaggerate.' },
        callbackSaved: null,
      }
    }
    case 'search_guides': {
      const input = QueryInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const passages = await searchGuides(input.data.query)
      return {
        result: passages.length > 0
          ? { ok: true, passages: passages.map(spokenPassage), note: `Give the gist in a sentence or two, as the shop's own advice ("our guide on mesh chairs says..."). Do not read it out at length. ${LINKS_NOTE}` }
          : { ok: false, message: 'The shop has no article on that. Answer from the products instead, or say you cannot see it.' },
        callbackSaved: null,
      }
    }
    case 'raise_order_request': {
      const input = RaiseRequestInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      if (!callerAgreement(input.data.caller_agreed)) {
        return {
          result: {
            ok: false,
            raised: false,
            message: 'Nothing has been raised. Read back what you are about to raise (which order, which items, and why) and ask the caller whether you should go ahead. Only once they say yes, call this again with their words in caller_agreed.',
          },
          callbackSaved: null,
        }
      }
      const call = await resolveCall(input.data)
      if (!call) return { result: { ok: false, message: 'Requests can only be raised on a live phone call. Offer a callback instead.' }, callbackSaved: null }
      try {
        const result = await raiseOrderRequest(call, {
          kind: input.data.kind,
          reason: input.data.reason.toUpperCase(),
          orderNumber: blankToNull(input.data.order_number),
          items: (input.data.items ?? []).map((entry) => ({ item: entry.item, quantity: entry.quantity ?? null, missing: entry.missing ?? null })),
          whatHappened: blankToNull(input.data.what_happened),
          photoNote: blankToNull(input.data.photo_note),
        })
        return { result, callbackSaved: null }
      } catch (error) {
        // A failure must not leave the assistant silent on a live call.
        console.error('[ai-call-answering] raise_order_request failed', error)
        return { result: { ok: false, raised: false, message: 'It could not be raised just now. Do not tell the caller it was. Offer a callback instead.' }, callbackSaved: null }
      }
    }
    case 'note_unanswered': {
      const input = UnansweredInput.safeParse(body)
      if (!input.success) return { result: BAD_INPUT, callbackSaved: null }
      const call = await resolveCall(input.data)
      if (call) await recordUnanswered(call.id, input.data.question, 'tool', input.data.topic ?? '')
      return { result: { ok: true, message: 'Noted. Say nothing about it to the caller.' }, callbackSaved: null }
    }
  }
}

import { escapeHtml } from '@/lib/email/render'
import { sanitizeEmailHtml } from '@/lib/sanitize'
import { sendTemplateEmail } from '@/lib/email'
import { renderProductTable } from '@/modules/unified-inbox/lib/products/render'
import { resolveProducts } from '@/modules/unified-inbox/lib/products'
import { recentEmailsFrom, recordEmailSent, type CallRecord } from './calls'
import { toProductRefs } from './product-queries'
import { basketUrl, getCallBasket } from './phone-basket'
import { getSettings } from './settings'
import { isPlausibleEmail } from './text'
import { askWhichEmailMessage, chooseOrderEmail } from './email-choice'
import { emailsOnOrders, nameOnOrderEmail } from './order-queries'

// ---------------------------------------------------------------------------
// Emailing a caller a written note of what was discussed on the phone.
//
// It goes out through core's email sender as the `ai-call-answering` module, so
// the Unified Inbox settings decide which of the site's addresses it leaves as
// and which inbox keeps a copy (Settings > AI Call Answering > Assistant >
// Sending address). Nothing here knows about inboxes.
//
// The words are the model's, but only ever as escaped text: nothing it writes
// can become markup, and the products are looked up by id here rather than
// described by the model, so a link or a price in the email is always the
// shop's own. They are printed by the unified inbox's own product table, so the
// email shows them exactly as a product attached to a reply does: photograph,
// linked name, the options of a variation, and the price with "+ VAT" where the
// shop quotes net prices. Order details are never part of it - the tool's description says
// so, and the address may be one the caller merely spoke.
// ---------------------------------------------------------------------------

export const MAX_EMAILS_PER_CALL = 3
export const MAX_EMAILS_PER_NUMBER_PER_HOUR = 6
export const MAX_PRODUCTS_PER_EMAIL = 5

const SUMMARY_MAX = 3000

/** Plain text to email-safe HTML: blank lines split paragraphs, single newlines
 *  become line breaks. Everything is escaped. */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p !== '')
  return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('')
}

/** The signature, or '' for none. Plain text is escaped with its line breaks
 *  kept; a signature pasted as HTML (it starts with a tag) is sanitised the way
 *  an inbox signature is and used as written. */
export function signatureHtml(signature: string): string {
  const body = signature.replace(/\r\n?/g, '\n').trim()
  if (!body) return ''
  if (/^<[a-z!]/i.test(body)) {
    const html = sanitizeEmailHtml(body)
    return html ? `<div style="margin:24px 0 0;">${html}</div>` : ''
  }
  return `<p style="margin:24px 0 0;">${escapeHtml(body).replace(/\n/g, '<br>')}</p>`
}

/** One line, no markup-looking noise, short enough for a subject. */
export function cleanSubject(raw: string | undefined): string {
  const line = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
  return line || 'A note of what we talked about'
}

/** Who the email is for: an address the caller gave this time, else the one on
 *  the order they proved they own (they are asked which when the orders carry
 *  several), else one left for a callback. */
export function pickRecipient(
  call: Pick<CallRecord, 'callerEmail'>,
  given: string | null,
  orderEmails: readonly string[],
): { email: string; fromOrder: boolean } | { ask: string[] } | null {
  const spoken = (given ?? '').trim().toLowerCase()
  if (spoken && isPlausibleEmail(spoken)) {
    return { email: spoken, fromOrder: orderEmails.some((email) => email.toLowerCase() === spoken) }
  }
  const choice = chooseOrderEmail(orderEmails.filter(isPlausibleEmail), null)
  if (choice.kind === 'use') return { email: choice.email.toLowerCase(), fromOrder: true }
  if (choice.kind === 'ask') return { ask: choice.emails }
  const callback = call.callerEmail.trim().toLowerCase()
  return callback && isPlausibleEmail(callback) ? { email: callback, fromOrder: false } : null
}

/** A call with a phone basket gets its link in the email too, so a caller on a
 *  landline (who cannot be texted) still leaves with something to act on. */
async function basketParagraph(callId: string): Promise<string> {
  const basket = await getCallBasket(callId)
  if (!basket || basket.lines.length === 0) return ''
  const url = basketUrl(basket.token)
  return `<p><a href="${escapeHtml(url)}">Open the basket we put together on the phone</a> to see prices and delivery and check out.</p>`
}

export type SummaryInput = {
  email: string | null
  name: string | null
  subject: string | undefined
  summary: string
  productIds: string[]
}

export type SummaryOutcome = { ok: true } | { ok: false; message: string }

export async function emailCallSummary(call: CallRecord, input: SummaryInput): Promise<SummaryOutcome> {
  if (call.emailsSent >= MAX_EMAILS_PER_CALL || (await recentEmailsFrom(call.fromNumber)) >= MAX_EMAILS_PER_NUMBER_PER_HOUR) {
    return { ok: false, message: 'Too many emails have been sent on this call. Do not try again. Offer a callback instead.' }
  }
  const recipient = pickRecipient(call, input.email, await emailsOnOrders(call.verifiedOrders))
  if (recipient && 'ask' in recipient) return { ok: false, message: askWhichEmailMessage(recipient.ask) }
  if (!recipient) {
    return {
      ok: false,
      message: input.email
        ? 'That email address does not look right. Ask them to say it again slowly, read it back, and retry.'
        : 'I need an email address. Ask for it, read it back one character at a time, and retry once they confirm.',
    }
  }
  const summary = input.summary.trim().slice(0, SUMMARY_MAX)
  if (!summary) return { ok: false, message: 'There was nothing to put in the email. Write a short note of what was discussed and retry.' }

  const settings = await getSettings()
  const refs = await toProductRefs(input.productIds.slice(0, MAX_PRODUCTS_PER_EMAIL))
  const resolved = await resolveProducts(refs)
  const listing = renderProductTable(resolved.map((entry) => entry.choice))

  const sent = await sendTemplateEmail(recipient.email, 'ai-call-answering.call-summary', {
    customerName: input.name?.trim() || (recipient.fromOrder ? await nameOnOrderEmail(call.verifiedOrders, recipient.email) : '') || call.callerName || 'there',
    subject: cleanSubject(input.subject),
    summaryHtml: textToHtml(summary) + (await basketParagraph(call.id)),
    productsHtml: listing,
    hasProducts: listing ? 'true' : '',
    signatureHtml: signatureHtml(settings.emailSignature),
  })
  if (!sent) return { ok: false, message: 'The email could not be sent just now. Offer a callback instead.' }
  await recordEmailSent(call.id, recipient.email)
  return { ok: true }
}

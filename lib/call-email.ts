import { escapeHtml } from '@/lib/email/render'
import { sanitizeEmailHtml } from '@/lib/sanitize'
import { sendTemplateEmail } from '@/lib/email'
import { getSiteUrl } from '@/lib/config/env'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { productUrl } from '@/modules/shop/lib/product-url'
import { recentEmailsFrom, recordEmailSent, type CallRecord } from './calls'
import { getProductLinks } from './product-queries'
import { getSettings } from './settings'
import { isPlausibleEmail } from './text'

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
// shop's own. Order details are never part of it - the tool's description says
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
 *  the order they proved they own, else one left for a callback. */
export function pickRecipient(call: CallRecord, given: string | null): { email: string; fromOrder: boolean } | null {
  const candidates: Array<[string, boolean]> = [
    [given ?? '', false],
    [call.verifiedContact.email, true],
    [call.callerEmail, false],
  ]
  for (const [value, fromOrder] of candidates) {
    const email = value.trim().toLowerCase()
    if (email && isPlausibleEmail(email)) return { email, fromOrder }
  }
  return null
}

export type ProductLink = { name: string; price: string; basis: string; url: string }

export function productsHtml(products: ProductLink[]): string {
  const items = products.map((p) =>
    `<li><a href="${escapeHtml(p.url)}">${escapeHtml(p.name)}</a> - ${escapeHtml(p.price)} ${escapeHtml(p.basis)}</li>`)
  return items.length > 0 ? `<ul>${items.join('')}</ul>` : ''
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
  const recipient = pickRecipient(call, input.email)
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

  const [settings, config] = await Promise.all([getSettings(), getShopConfigCached()])
  const siteUrl = getSiteUrl()
  const found = await getProductLinks(input.productIds.slice(0, MAX_PRODUCTS_PER_EMAIL))
  const links: ProductLink[] = found.map((p) => ({
    name: p.name,
    price: p.price,
    basis: p.basis,
    url: productUrl(siteUrl, p.slug, config.productUrlStyle),
  }))
  const listing = productsHtml(links)

  const sent = await sendTemplateEmail(recipient.email, 'ai-call-answering.call-summary', {
    customerName: input.name?.trim() || (recipient.fromOrder ? call.verifiedContact.name : '') || call.callerName || 'there',
    subject: cleanSubject(input.subject),
    summaryHtml: textToHtml(summary),
    productsHtml: listing,
    hasProducts: listing ? 'true' : '',
    signatureHtml: signatureHtml(settings.emailSignature),
  })
  if (!sent) return { ok: false, message: 'The email could not be sent just now. Offer a callback instead.' }
  await recordEmailSent(call.id, recipient.email)
  return { ok: true }
}

import { callerLabel, recentEmailsFrom, recordEmailSent, type CallRecord } from './calls'
import { MAX_EMAILS_PER_CALL, MAX_EMAILS_PER_NUMBER_PER_HOUR } from './call-email'
import { getCallBasket, recordBasketQuote } from './phone-basket'
import { titleCaseName } from './name-case'
import { saveQuote } from './quote-saver'
import { isPlausibleEmail } from './text'

// The handler behind save_quote: the call's basket, saved as a quote under the
// name and email the caller gave. The quote module emails it to them, so this
// is the one and only way the quote reaches the caller by email - the summary
// email leaves the quote's lines and link out once it has gone (call-email.ts).
// Every answer is words the model can say or act on (see tool-handlers.ts).

/** Quotes one call may save: the first, and a couple of corrections. */
export const MAX_QUOTES_PER_CALL = 3

type Result = Record<string, unknown>

/** A number worth putting on the quote: the one they rang from, unless withheld. */
function quotePhone(call: CallRecord): string {
  if (call.verifiedContact.phone) return call.verifiedContact.phone
  return /^\+\d{6,}$/.test(call.fromNumber) ? call.fromNumber : ''
}

export async function saveBasketQuote(call: CallRecord, input: { name: string | null; email: string | null }): Promise<Result> {
  const basket = await getCallBasket(call.id)
  if (!basket || basket.lines.length === 0) {
    return { ok: false, message: 'There is no basket on this call yet. Build it first with build_basket, then save the quote.' }
  }
  if (basket.quote) {
    return {
      ok: false,
      alreadySaved: true,
      message: `This basket is already saved as quote ${basket.quote.number}${basket.quote.emailed ? ' and was emailed to them' : ''}. Do not save or email it again. If they change the list, call build_basket with the whole new list first, then save_quote again.`,
    }
  }
  if (basket.quotesSaved >= MAX_QUOTES_PER_CALL) {
    return { ok: false, message: 'Enough quotes have been saved on this call. Do not try again. Offer a callback so the team can send a final one.' }
  }

  const name = titleCaseName((input.name ?? '').trim() || call.verifiedContact.name.trim())
  const email = ((input.email ?? '').trim() || call.verifiedContact.email.trim()).toLowerCase()
  if (!name) return { ok: false, message: 'I need the caller\'s name for the quote. Ask for it and retry.' }
  if (!email || !isPlausibleEmail(email)) {
    return {
      ok: false,
      message: input.email
        ? 'That email address does not look right. Ask them to say it again slowly, read it back one character at a time, and retry once they confirm.'
        : 'I need an email address to send the quote to. Ask for it, read it back one character at a time, and retry once they confirm.',
    }
  }
  // The quote is an email to an address spoken on the phone, so it counts
  // against the same caps as every other email this module sends.
  if (call.emailsSent >= MAX_EMAILS_PER_CALL || (await recentEmailsFrom(call.fromNumber)) >= MAX_EMAILS_PER_NUMBER_PER_HOUR) {
    return { ok: false, message: 'Too many emails have been sent on this call to send a quote as well. Offer to text the basket link (send_text with what "basket") or a callback instead.' }
  }

  let saved
  try {
    saved = await saveQuote({
      lines: basket.lines.map(({ productId, quantity, meta }) => ({ productId, quantity, ...(meta ? { meta } : {}) })),
      customerName: name,
      customerEmail: email,
      customerPhone: quotePhone(call),
      staffNotes: `Saved by the phone assistant during a call from ${callerLabel(call)}.`,
    })
  } catch {
    return { ok: false, message: 'The quote could not be saved just now. Offer to text the basket link (send_text with what "basket") instead.' }
  }
  if (!saved) {
    return { ok: false, message: 'This shop does not save quotes. Offer to text the basket link instead (send_text with what "basket").' }
  }
  if (!saved.ok) {
    return { ok: false, message: `The quote could not be saved: ${saved.message} Offer to text the basket link instead (send_text with what "basket").` }
  }

  await recordBasketQuote(call.id, {
    id: saved.quote.id,
    number: saved.quote.quoteNumber,
    url: saved.quote.url,
    emailed: saved.emailedCustomer,
  })
  if (saved.emailedCustomer) await recordEmailSent(call.id, email)

  const dropped = saved.unavailable.length > 0
    ? `${saved.unavailable.length} item(s) could not be quoted and were left off (${saved.unavailable.map((line) => line.name).join(', ')}): tell the caller which.`
    : ''
  return {
    ok: true,
    quoteNumber: saved.quote.quoteNumber,
    emailed: saved.emailedCustomer,
    message: [
      saved.emailedCustomer
        ? `Saved as quote ${saved.quote.quoteNumber}, and the shop has emailed it to them with a link that opens the basket. Tell the caller the quote number and that it is on its way; it may take a minute or two, so check the junk folder.`
        : `Saved as quote ${saved.quote.quoteNumber}, but the shop does not email quotes, so it has NOT been sent. Offer to text them the link (send_text with what "basket" now sends the quote).`,
      dropped,
      'The quote is the written record of the basket. Do NOT email the quote, its items or its link again by any other means. email_summary is only for OTHER questions the quote does not answer, and leaves the quote out.',
    ].filter(Boolean).join(' '),
  }
}

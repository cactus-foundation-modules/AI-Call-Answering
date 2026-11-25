import { prisma } from '@/lib/db/prisma'
import { isSmsReady, sendSiteSms } from '@/modules/twilio/lib/numbers'
import type { CallRecord } from './calls'

// ---------------------------------------------------------------------------
// Texting the caller.
//
// An email address said down a phone line is the single most error-prone thing
// the assistant handles: one call sent a summary to "tailor-guest" before the
// caller had said yes. A text needs nothing spelled. It goes to the number the
// caller is ringing from and nowhere else - never a number said aloud - so a
// spoofed caller id texts the real owner of that number, not the spoofer, and
// the model cannot be talked into texting somebody else.
// ---------------------------------------------------------------------------

export const MAX_TEXTS_PER_CALL = 4
export const MAX_TEXTS_PER_NUMBER_PER_HOUR = 8
/** Three SMS segments. Long enough for a short note and a few links. */
/** Four segments: room for a note and three named links. */
export const MAX_TEXT_CHARS = 612

export type TextTarget = { ok: true; to: string } | { ok: false; message: string }

/** Whether the number the caller rang from can take a text. Withheld numbers
 *  and UK landlines cannot; anything else in international form is tried, and
 *  Twilio says if it cannot. Pure. */
export function textableNumber(fromNumber: string): TextTarget {
  const number = fromNumber.trim()
  if (!/^\+\d{8,15}$/.test(number)) {
    return { ok: false, message: 'The caller\'s number is withheld, so a text cannot be sent. Offer to email it instead.' }
  }
  if (number.startsWith('+44') && !number.startsWith('+447')) {
    return { ok: false, message: 'The caller is ringing from a landline, which cannot take texts. Offer to email it instead.' }
  }
  return { ok: true, to: number }
}

/** The note with its spacing tidied. */
function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// Ported from the chat assistant (lib/text-message.ts): each link with the
// product's name above it, and a sign-off with the site's own address.
/** One link in a text: what it is, then the address. */
export type TextLinkLine = { label: string | null; url: string }

const MAX_LABEL_CHARS = 60

/** A link's name, cleaned like a note and kept short. */
function cleanLabel(label: string | null): string {
  const clean = cleanText(label ?? '')
  return clean.length > MAX_LABEL_CHARS ? `${clean.slice(0, MAX_LABEL_CHARS - 1).replace(/\s+\S*$/, '')}…` : clean
}

/**
 * The text itself: the note, then each link as its name on one line and its
 * address on the next, a blank line between them, then the sign-off.
 *
 * Learned on a live chat: three addresses one under another, with nothing to
 * say which was which, read as "a garbled mess". Kept inside MAX_TEXT_CHARS
 * without cutting an address in half: the note is shortened first, then the
 * names are dropped, never the addresses. Pure.
 */
export function composeText(note: string, links: readonly TextLinkLine[], signOff: string): string {
  const named = links.map((link) => [cleanLabel(link.label), link.url].filter(Boolean).join('\n'))
  const bare = links.map((link) => link.url)
  const tailOf = (blocks: string[]) => [...blocks, signOff.trim()].filter(Boolean).join('\n\n')
  let tail = tailOf(named)
  if (MAX_TEXT_CHARS - tail.length - 2 < 20) tail = tailOf(bare)
  const room = MAX_TEXT_CHARS - tail.length - 2
  let body = cleanText(note)
  if (room < 20) body = ''
  else if (body.length > room) body = `${body.slice(0, room - 1).replace(/\s+\S*$/, '')}…`
  return [body, tail].filter(Boolean).join('\n\n').slice(0, MAX_TEXT_CHARS)
}

/**
 * How a text signs off: the site's own address, so whoever reads it knows who
 * it is from and where to go ("Deskwell.co.uk", not just "Deskwell"). Written
 * with the business's own capitals where the address starts with its name;
 * the bare host where it does not; the name alone with no address. Pure.
 */
export function textSignOff(businessName: string, siteUrl: string | null): string {
  const name = businessName.trim()
  let host: string | null = null
  try {
    host = siteUrl ? new URL(siteUrl).hostname.replace(/^www\./, '') : null
  } catch {
    host = null
  }
  if (!host || host === 'localhost') return name
  const joined = name.replace(/\s+/g, '')
  if (joined && host.toLowerCase().startsWith(joined.toLowerCase())) return `${joined}${host.slice(joined.length)}`
  return host
}

async function recentTextsFrom(fromNumber: string): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ total: number | bigint | null }>>`
    SELECT COALESCE(SUM("texts_sent"), 0) AS total FROM "acall_calls"
    WHERE "from_number" = ${fromNumber} AND "started_at" > CURRENT_TIMESTAMP - INTERVAL '1 hour'
  `
  return Number(rows[0]?.total ?? 0)
}

export type TextOutcome = { ok: true } | { ok: false; message: string }

/** Sends one text to the caller's own number, within the limits. */
export async function textCaller(call: CallRecord, body: string): Promise<TextOutcome> {
  const target = textableNumber(call.fromNumber)
  if (!target.ok) return target
  if (!(await isSmsReady())) {
    return { ok: false, message: 'Texts are not set up for this shop. Offer to email it instead.' }
  }
  const sentOnCall = await prisma.$queryRaw<Array<{ texts_sent: number }>>`
    SELECT "texts_sent" FROM "acall_calls" WHERE "id" = ${call.id}
  `
  if ((sentOnCall[0]?.texts_sent ?? 0) >= MAX_TEXTS_PER_CALL || (await recentTextsFrom(call.fromNumber)) >= MAX_TEXTS_PER_NUMBER_PER_HOUR) {
    return { ok: false, message: 'Enough texts have been sent on this call. Do not send another. Offer to email it instead.' }
  }
  try {
    await sendSiteSms(target.to, body.slice(0, MAX_TEXT_CHARS))
  } catch (error) {
    console.error('[ai-call-answering] text to caller failed', error)
    return { ok: false, message: 'The text could not be sent just now. Offer to email it instead.' }
  }
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET "texts_sent" = "texts_sent" + 1, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${call.id}
  `
  return { ok: true }
}

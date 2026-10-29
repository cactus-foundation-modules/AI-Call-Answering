import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import type { CallRecord } from './calls'
import { emailsOnOrders } from './order-queries'

// ---------------------------------------------------------------------------
// "I rang yesterday about the chairs." What this caller has said to the shop
// before: earlier calls to the assistant, live chats, and threads in the
// unified inbox (emails, texts, voicemails, contact forms), plus any return or
// damage request still open on an order they proved is theirs.
//
// Matched on the number they are ringing from - the same trust the order
// lookup already places in it - and, once an order is verified, on the email
// addresses on that order. Each item is a date, a channel and a line of what it
// was about: enough to recognise what the caller means, not a transcript to
// read back. Addresses and numbers never go to the model.
//
// Chat and the inbox are other modules' tables, read only if they are there.
// ---------------------------------------------------------------------------

export const HISTORY_DAYS = 120
const MAX_PER_SOURCE = 5
const LINE_CHARS = 220

export type HistoryItem = {
  when: string
  channel: 'call' | 'chat' | 'email' | 'text' | 'voicemail' | 'form' | 'other'
  about: string
  /** Still waiting on the shop, as far as its own records say. */
  open: boolean
}

type Dated = HistoryItem & { at: Date }

const tableCache = new Map<string, boolean>()
async function tableExists(table: string): Promise<boolean> {
  const cached = tableCache.get(table)
  if (cached !== undefined) return cached
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`
  const present = rows[0]?.present === true
  tableCache.set(table, present)
  return present
}

/** The forms a number may be stored in elsewhere: international and, for UK
 *  numbers, national ("07..."), which is how chat and the inbox keep them. */
export function numberForms(e164: string): string[] {
  const number = e164.trim()
  if (!/^\+\d{8,15}$/.test(number)) return []
  return number.startsWith('+44') ? [number, `0${number.slice(3)}`] : [number]
}

function line(text: string | null | undefined): string {
  const flat = (text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  // Addresses and long digit runs are the caller's own details: they do not
  // need reading back to them, and the model must not be tempted to.
  const scrubbed = flat
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/\+?\d[\d\s]{8,}\d/g, '[number]')
  return scrubbed.length > LINE_CHARS ? `${scrubbed.slice(0, LINE_CHARS - 1)}…` : scrubbed
}

/** "Tuesday 27 October", in the shop's own time zone. */
export function spokenDate(date: Date): string {
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })
}

function inboxChannel(channel: string): HistoryItem['channel'] {
  if (channel === 'email') return 'email'
  if (channel === 'sms' || channel === 'whatsapp') return 'text'
  if (channel === 'phone') return 'voicemail'
  if (channel === 'form') return 'form'
  return 'other'
}

async function earlierCalls(call: CallRecord, since: Date): Promise<Dated[]> {
  if (!numberForms(call.fromNumber).length) return []
  const rows = await prisma.$queryRaw<Array<{ started_at: Date; summary: string; callback_needed: boolean; callback_reason: string; handled_at: Date | null }>>`
    SELECT "started_at", "summary", "callback_needed", "callback_reason", "handled_at" FROM "acall_calls"
    WHERE "from_number" = ${call.fromNumber} AND "id" <> ${call.id} AND "status" = 'completed'
      AND "started_at" > ${since} AND "duration_seconds" > 15
    ORDER BY "started_at" DESC LIMIT ${MAX_PER_SOURCE}
  `
  return rows.map((row) => ({
    at: row.started_at,
    when: spokenDate(row.started_at),
    channel: 'call' as const,
    about: line(row.callback_needed && row.callback_reason ? `Left a message: ${row.callback_reason}` : row.summary),
    open: row.callback_needed && row.handled_at === null,
  }))
}

async function chats(forms: string[], emails: string[], since: Date): Promise<Dated[]> {
  if ((forms.length === 0 && emails.length === 0) || !(await tableExists('chat_conversations'))) return []
  const rows = await prisma.$queryRaw<Array<{ created_at: Date; last_message_preview: string | null; status: string }>>`
    SELECT "created_at", "last_message_preview", "status" FROM "chat_conversations"
    WHERE ("visitor_phone" = ANY(${forms}::text[]) OR lower("visitor_email") = ANY(${emails}::text[]))
      AND "created_at" > ${since}
    ORDER BY "created_at" DESC LIMIT ${MAX_PER_SOURCE}
  `
  return rows.map((row) => ({
    at: row.created_at,
    when: spokenDate(row.created_at),
    channel: 'chat' as const,
    about: line(row.last_message_preview) || 'A live chat',
    open: row.status === 'open',
  }))
}

async function inboxThreads(forms: string[], emails: string[], since: Date): Promise<Dated[]> {
  if ((forms.length === 0 && emails.length === 0) || !(await tableExists('uin_messages'))) return []
  // The newest message the caller sent in each thread. Chat is read from its
  // own table above; notes are staff talking to each other.
  const rows = await prisma.$queryRaw<Array<{ sent_at: Date; channel: string; subject: string | null; snippet: string | null; handled_at: Date | null }>>`
    SELECT DISTINCT ON ("thread_id") "sent_at", "channel", "subject", "snippet", "handled_at"
    FROM "uin_messages"
    WHERE "direction" = 'in' AND "channel" <> 'chat' AND "sent_at" > ${since}
      AND ("from_phone" = ANY(${forms}::text[]) OR lower("from_address") = ANY(${emails}::text[]))
    ORDER BY "thread_id", "sent_at" DESC
  `
  return rows
    .sort((a, b) => b.sent_at.getTime() - a.sent_at.getTime())
    .slice(0, MAX_PER_SOURCE)
    .map((row) => ({
      at: row.sent_at,
      when: spokenDate(row.sent_at),
      channel: inboxChannel(row.channel),
      about: line([row.subject, row.snippet].filter(Boolean).join(' - ')) || 'A message',
      open: row.handled_at === null,
    }))
}

export type OpenRequest = { orderNumber: string; type: string; status: string; raised: string }

async function openRequests(verifiedOrders: string[]): Promise<OpenRequest[]> {
  if (verifiedOrders.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ order_number: string; type: string; status: string; created_at: Date }>>(Prisma.sql`
    SELECT o."order_number", r."type", r."status", r."created_at"
    FROM "shp_order_requests" r JOIN "shp_orders" o ON o."id" = r."order_id"
    WHERE o."order_number" IN (${Prisma.join(verifiedOrders)})
      AND r."status" IN ('PENDING', 'APPROVED')
    ORDER BY r."created_at" DESC LIMIT ${MAX_PER_SOURCE}
  `)
  return rows.map((row) => ({
    orderNumber: row.order_number,
    type: row.type.toLowerCase(),
    status: row.status.toLowerCase().replace(/_/g, ' '),
    raised: spokenDate(row.created_at),
  }))
}

export type CallerHistory = {
  items: HistoryItem[]
  openRequests: OpenRequest[]
}

export async function callerHistory(call: CallRecord, now: Date = new Date()): Promise<CallerHistory> {
  const since = new Date(now.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000)
  const forms = numberForms(call.fromNumber)
  const emails = call.verifiedOrders.length > 0
    ? (await emailsOnOrders(call.verifiedOrders)).map((email) => email.toLowerCase())
    : []
  const [calls, chatItems, inbox, requests] = await Promise.all([
    earlierCalls(call, since),
    chats(forms, emails, since).catch(() => []),
    inboxThreads(forms, emails, since).catch(() => []),
    openRequests(call.verifiedOrders),
  ])
  const items = [...calls, ...chatItems, ...inbox]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, MAX_PER_SOURCE * 2)
    .map(({ at: _at, ...item }) => item)
  return { items, openRequests: requests }
}

import { prisma } from '@/lib/db/prisma'
import type {
  ConversationIdentity,
  ConversationListOptions,
  ConversationListPage,
  ConversationProvider,
  ConversationSummary,
  ConversationThread,
} from '@/lib/conversations/types'
import { buildOverview, buildTranscriptText, formatDuration } from './call-overview'
import { getCall, mapCall, markRead, type CallRecord } from './calls'

// The assistant's calls, published as conversations.
//
// This is how every call the assistant handles reaches the unified inbox with a
// written overview: the inbox asks `core.conversation-provider` entries for
// their conversations, and this one answers from `acall_calls`. Nothing here
// names the inbox and nothing in the inbox names this module.
//
// SERVER ONLY. The manifest entry sets serverOnly: it reads the database.

const PREVIEW_CHARS = 160

const COLUMNS = `
  id, call_sid, conversation_id, from_number, to_number, status, started_at, duration_seconds,
  summary, transcript, caller_name, caller_email, caller_phone, callback_needed, callback_reason,
  handled_at, read_at, verified_orders, failed_order_checks, updated_at
`

function preview(text: string): string | null {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS - 1)}…` : flat
}

function lastActivity(call: CallRecord): Date {
  return call.status === 'completed'
    ? new Date(call.startedAt.getTime() + call.durationSeconds * 1000)
    : call.startedAt
}

function phoneOf(call: CallRecord): string | null {
  if (call.callerPhone) return call.callerPhone
  return /^\+/.test(call.fromNumber) ? call.fromNumber : null
}

export function toSummary(call: CallRecord): ConversationSummary {
  const open = call.status === 'in_progress' || (call.callbackNeeded && !call.handledAt)
  return {
    id: call.id,
    channel: 'phone',
    subject: call.callbackNeeded ? 'Phone assistant: callback requested' : 'Phone assistant call',
    preview: preview(call.status === 'in_progress' ? 'Call in progress' : call.summary),
    participant: {
      name: call.callerName || null,
      email: call.callerEmail || null,
      phone: phoneOf(call),
    },
    lastMessageAt: lastActivity(call),
    contentAt: call.updatedAt > lastActivity(call) ? call.updatedAt : undefined,
    unread: call.readAt === null && call.status === 'completed',
    status: open ? 'open' : 'closed',
    href: `config?tab=ai-call-answering&sub=calls&call=${encodeURIComponent(call.id)}`,
    sourceLabel: 'Phone assistant',
  }
}

type Cursor = { startedAt: string; id: string }

function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null
  const separator = value.indexOf('|')
  if (separator < 1) return null
  const startedAt = value.slice(0, separator)
  return Number.isNaN(Date.parse(startedAt)) ? null : { startedAt, id: value.slice(separator + 1) }
}

async function list(options: ConversationListOptions): Promise<ConversationListPage> {
  const cursor = decodeCursor(options.cursor)
  const since = options.since ?? new Date(0)
  const take = Math.min(Math.max(options.limit, 1), 200)
  const rows = cursor
    ? await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT ${COLUMNS} FROM "acall_calls"
         WHERE updated_at >= $1 AND (started_at, id) < ($2::timestamp, $3)
         ORDER BY started_at DESC, id DESC LIMIT $4`,
        since, cursor.startedAt, cursor.id, take + 1,
      )
    : await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT ${COLUMNS} FROM "acall_calls"
         WHERE updated_at >= $1
         ORDER BY started_at DESC, id DESC LIMIT $2`,
        since, take + 1,
      )
  const page = rows.slice(0, take).map(mapCall)
  const last = page[page.length - 1]
  const more = rows.length > take && last !== undefined
  return {
    items: page.map(toSummary),
    nextCursor: more ? `${last.startedAt.toISOString()}|${last.id}` : undefined,
  }
}

async function thread(id: string): Promise<ConversationThread | null> {
  const call = await getCall(id)
  if (!call) return null
  return {
    summary: toSummary(call),
    messages: [
      {
        id: `${call.id}:overview`,
        direction: 'in',
        authorName: 'Phone assistant',
        text: buildOverview(call),
        html: null,
        sentAt: call.startedAt,
        attachments: [],
        medium: 'call',
      },
      ...(call.transcript.length > 0
        ? [{
            id: `${call.id}:transcript`,
            direction: 'in' as const,
            authorName: `Transcript (${formatDuration(call.durationSeconds)})`,
            text: buildTranscriptText(call),
            html: null,
            sentAt: lastActivity(call),
            attachments: [],
            medium: 'call' as const,
          }]
        : []),
    ],
  }
}

async function byIdentity(identity: ConversationIdentity): Promise<ConversationSummary[]> {
  const emails = identity.emails.map((email) => email.trim().toLowerCase()).filter(Boolean)
  const phones = identity.phones.map((phone) => phone.trim()).filter(Boolean)
  if (emails.length === 0 && phones.length === 0) return []
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ${COLUMNS} FROM "acall_calls"
     WHERE lower(caller_email) = ANY($1::text[]) OR from_number = ANY($2::text[]) OR caller_phone = ANY($2::text[])
     ORDER BY started_at DESC LIMIT 100`,
    emails, phones,
  )
  return rows.map(mapCall).map(toSummary)
}

async function markConversationRead(id: string): Promise<void> {
  await markRead(id)
}

export const aiCallConversationProvider: ConversationProvider = {
  label: 'AI calls',
  channel: 'phone',
  capabilities: { reply: false, markRead: true, byIdentity: true },
  list,
  thread,
  markRead: markConversationRead,
  byIdentity,
}


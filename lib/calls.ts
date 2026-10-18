import { prisma } from '@/lib/db/prisma'

// The record of each call the assistant took. One row per Twilio call, opened
// when the call is handed over and completed when ElevenLabs delivers the
// transcript. Everything the inbox and the settings screen show about a call
// is read from here.

export type TranscriptTurn = {
  role: 'caller' | 'assistant'
  text: string
  /** Seconds into the call, when ElevenLabs said. */
  at: number | null
}

export type CallRecord = {
  id: string
  callSid: string
  conversationId: string | null
  fromNumber: string
  toNumber: string
  status: 'in_progress' | 'completed'
  startedAt: Date
  durationSeconds: number
  summary: string
  transcript: TranscriptTurn[]
  callerName: string
  callerEmail: string
  callerPhone: string
  callbackNeeded: boolean
  callbackReason: string
  handledAt: Date | null
  readAt: Date | null
  verifiedOrders: string[]
  failedOrderChecks: number
  updatedAt: Date
}

const COLUMNS = `
  id, call_sid, conversation_id, from_number, to_number, status, started_at, duration_seconds,
  summary, transcript, caller_name, caller_email, caller_phone, callback_needed, callback_reason,
  handled_at, read_at, verified_orders, failed_order_checks, updated_at
`

function parseTranscript(value: unknown): TranscriptTurn[] {
  if (!Array.isArray(value)) return []
  const turns: TranscriptTurn[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const turn = item as Record<string, unknown>
    if ((turn.role !== 'caller' && turn.role !== 'assistant') || typeof turn.text !== 'string') continue
    turns.push({ role: turn.role, text: turn.text, at: typeof turn.at === 'number' ? turn.at : null })
  }
  return turns
}

export function mapCall(row: Record<string, unknown>): CallRecord {
  return {
    id: row.id as string,
    callSid: row.call_sid as string,
    conversationId: (row.conversation_id as string | null) ?? null,
    fromNumber: row.from_number as string,
    toNumber: row.to_number as string,
    status: row.status === 'completed' ? 'completed' : 'in_progress',
    startedAt: row.started_at as Date,
    durationSeconds: Number(row.duration_seconds),
    summary: row.summary as string,
    transcript: parseTranscript(row.transcript),
    callerName: row.caller_name as string,
    callerEmail: row.caller_email as string,
    callerPhone: row.caller_phone as string,
    callbackNeeded: row.callback_needed === true,
    callbackReason: row.callback_reason as string,
    handledAt: (row.handled_at as Date | null) ?? null,
    readAt: (row.read_at as Date | null) ?? null,
    verifiedOrders: Array.isArray(row.verified_orders) ? (row.verified_orders as string[]) : [],
    failedOrderChecks: Number(row.failed_order_checks),
    updatedAt: row.updated_at as Date,
  }
}

/** Opens the record for a call that has just been handed to the assistant. A
 *  repeat for the same call (Twilio retries a webhook) changes nothing. */
export async function openCall(input: { callSid: string; fromNumber: string; toNumber: string }): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "acall_calls" ("call_sid", "from_number", "to_number")
    VALUES (${input.callSid}, ${input.fromNumber}, ${input.toNumber})
    ON CONFLICT ("call_sid") DO NOTHING
  `
}

/** Finds the call a tool or the post-call webhook is talking about. The call SID
 *  is ours and always right; the conversation id is the fallback for a call
 *  whose row was opened by a different route. */
export async function findCall(ids: { callSid?: string | null; conversationId?: string | null }): Promise<CallRecord | null> {
  if (ids.callSid) {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM "acall_calls" WHERE call_sid = $1 LIMIT 1`, ids.callSid,
    )
    if (rows[0]) return mapCall(rows[0])
  }
  if (ids.conversationId) {
    const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM "acall_calls" WHERE conversation_id = $1 LIMIT 1`, ids.conversationId,
    )
    if (rows[0]) return mapCall(rows[0])
  }
  return null
}

export async function getCall(id: string): Promise<CallRecord | null> {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ${COLUMNS} FROM "acall_calls" WHERE id = $1 LIMIT 1`, id,
  )
  return rows[0] ? mapCall(rows[0]) : null
}

export async function linkConversation(callId: string, conversationId: string): Promise<void> {
  if (!conversationId) return
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET "conversation_id" = ${conversationId}, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${callId} AND "conversation_id" IS NULL
      AND NOT EXISTS (SELECT 1 FROM "acall_calls" other WHERE other."conversation_id" = ${conversationId})
  `
}

export async function recordCallback(
  callId: string,
  details: { name: string; email: string; reason: string },
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET
      "caller_name" = ${details.name},
      "caller_email" = ${details.email},
      "callback_needed" = true,
      "callback_reason" = ${details.reason},
      "handled_at" = NULL,
      "read_at" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${callId}
  `
}

export async function recordVerifiedOrder(callId: string, orderNumber: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET
      "verified_orders" = CASE WHEN ${orderNumber}::text = ANY("verified_orders") THEN "verified_orders" ELSE array_append("verified_orders", ${orderNumber}::text) END,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${callId}
  `
}

export async function recordFailedOrderCheck(callId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET "failed_order_checks" = "failed_order_checks" + 1, "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${callId}
  `
}

/** Wrong order checks made from one number in the last hour, across calls. A
 *  caller hung up on after three misses cannot simply ring back for three more. */
export async function recentFailedChecksFrom(fromNumber: string): Promise<number> {
  if (!fromNumber) return 0
  const rows = await prisma.$queryRaw<Array<{ total: number | bigint | null }>>`
    SELECT COALESCE(SUM("failed_order_checks"), 0) AS total FROM "acall_calls"
    WHERE "from_number" = ${fromNumber} AND "started_at" > CURRENT_TIMESTAMP - INTERVAL '1 hour'
  `
  return Number(rows[0]?.total ?? 0)
}

export type CompletedCallDetails = {
  conversationId: string
  durationSeconds: number
  summary: string
  transcript: TranscriptTurn[]
  startedAt: Date | null
}

export async function completeCall(callId: string, details: CompletedCallDetails): Promise<void> {
  const transcript = JSON.stringify(details.transcript)
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET
      "status" = 'completed',
      "duration_seconds" = ${details.durationSeconds},
      "summary" = ${details.summary},
      "transcript" = ${transcript}::jsonb,
      "started_at" = COALESCE(${details.startedAt}::timestamp, "started_at"),
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${callId}
  `
}

/** For a call that arrived with no row (the handler never ran here, or the row
 *  was lost): create it from what the post-call webhook knows. */
export async function createCompletedCall(input: {
  callSid: string
  fromNumber: string
  toNumber: string
}): Promise<CallRecord | null> {
  await openCall(input)
  return findCall({ callSid: input.callSid })
}

export async function setHandled(callId: string, handled: boolean): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET
      "handled_at" = ${handled ? new Date() : null}::timestamp,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${callId}
  `
}

export async function markRead(callId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET "read_at" = CURRENT_TIMESTAMP WHERE "id" = ${callId} AND "read_at" IS NULL
  `
}

export async function listRecentCalls(limit: number): Promise<CallRecord[]> {
  const rows = await prisma.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT ${COLUMNS} FROM "acall_calls" ORDER BY started_at DESC, id LIMIT $1`, limit,
  )
  return rows.map(mapCall)
}

export function callerLabel(call: Pick<CallRecord, 'callerName' | 'fromNumber'>): string {
  if (call.callerName) return call.callerName
  return /^\+/.test(call.fromNumber) ? call.fromNumber : 'a withheld number'
}

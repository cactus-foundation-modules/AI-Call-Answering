import { prisma } from '@/lib/db/prisma'
import type { ToolName } from './agent-config'

// What the assistant looked up on a call, kept beside the transcript.
//
// The transcript only holds what was said. When the assistant tells a caller it
// has no bank details, the question is whether it never asked, asked and got
// nothing, or was told and ignored it - and only this log can say which.
//
// Pure apart from recordToolCall, so what is kept and what is dropped is pinned
// by a test.

export type ToolLogEntry = {
  tool: string
  /** Seconds into the call, measured from when the call was handed over and
   *  stamped by the database as the entry is written. Lines up (roughly) with
   *  the transcript's own times. */
  at: number | null
  ms: number
  input: Record<string, unknown>
  result: Record<string, unknown>
  failed: boolean
}

/** A busy call makes a few dozen lookups; past this the call is stuck in a loop
 *  and the rest add nothing. */
export const MAX_TOOL_LOG_ENTRIES = 80
/** Product answers can be long (every variation, every delivery date). Enough
 *  to see what came back, not a second copy of the catalogue. */
export const MAX_RESULT_CHARS = 3000

/** Tools whose answers carry a customer's order, address or contact details.
 *  Only the outcome is kept: the inbox can be read by staff who have no
 *  business with the order, and the order page holds the details anyway. */
const PRIVATE_RESULT_TOOLS: ReadonlySet<string> = new Set([
  'lookup_order',
  'lookup_caller_orders',
  'email_order_link',
  'email_summary',
  'save_callback',
  'send_text',
  'get_caller_history',
])
const OUTCOME_KEYS = ['ok', 'matched', 'locked', 'message', 'sent']

/** The ids ElevenLabs adds to every call, which say nothing about the lookup. */
const CALL_KEYS = new Set(['call_sid', 'conversation_id'])

function trimInput(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (CALL_KEYS.has(key)) continue
    out[key] = typeof value === 'string' && value.length > 500 ? `${value.slice(0, 500)}…` : value
  }
  return out
}

function trimResult(tool: string, result: Record<string, unknown>): Record<string, unknown> {
  if (PRIVATE_RESULT_TOOLS.has(tool)) {
    const out: Record<string, unknown> = {}
    for (const key of OUTCOME_KEYS) if (key in result) out[key] = result[key]
    if (Array.isArray(result.orders)) out.ordersFound = result.orders.length
    return out
  }
  const json = JSON.stringify(result)
  if (json.length <= MAX_RESULT_CHARS) return result
  return { truncated: true, preview: `${json.slice(0, MAX_RESULT_CHARS)}…` }
}

export function toolLogEntry(input: {
  tool: ToolName
  body: unknown
  result: Record<string, unknown>
  ms: number
  failed: boolean
}): ToolLogEntry {
  return {
    tool: input.tool,
    at: null,
    ms: Math.max(0, Math.round(input.ms)),
    input: trimInput(input.body),
    result: trimResult(input.tool, input.result),
    failed: input.failed,
  }
}

export function parseToolLog(value: unknown): ToolLogEntry[] {
  if (!Array.isArray(value)) return []
  const entries: ToolLogEntry[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    if (typeof entry.tool !== 'string') continue
    entries.push({
      tool: entry.tool,
      at: typeof entry.at === 'number' ? entry.at : null,
      ms: typeof entry.ms === 'number' ? entry.ms : 0,
      input: entry.input && typeof entry.input === 'object' ? (entry.input as Record<string, unknown>) : {},
      result: entry.result && typeof entry.result === 'object' ? (entry.result as Record<string, unknown>) : {},
      failed: entry.failed === true,
    })
  }
  return entries
}

/** One line for the inbox: which tool, with what, and whether it found anything. */
export function describeToolCall(entry: ToolLogEntry): string {
  const asked = Object.entries(entry.input)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(', ')
  let outcome: string
  if (entry.failed) outcome = 'failed'
  else if (entry.result.ok === false) outcome = typeof entry.result.message === 'string' ? `nothing - ${entry.result.message}` : 'nothing'
  else outcome = 'ok'
  return `[Looked up ${entry.tool}${asked ? ` (${asked})` : ''}: ${outcome}]`
}

/** Appends to the call's log, by call SID or conversation id, whichever the
 *  tool was given. Best effort: a log that cannot be written must never cost
 *  the caller their answer, so the route runs this after replying. */
export async function recordToolCall(
  ids: { callSid: string | null; conversationId: string | null },
  entry: ToolLogEntry,
): Promise<void> {
  if (!ids.callSid && !ids.conversationId) return
  const json = JSON.stringify(entry)
  await prisma.$executeRaw`
    UPDATE "acall_calls" SET "tool_log" = "tool_log" || jsonb_build_array(
      ${json}::jsonb || jsonb_build_object('at', GREATEST(0, round(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - "started_at"))))::int)
    )
    WHERE (("call_sid" = ${ids.callSid ?? ''} AND ${ids.callSid ?? ''} <> '')
        OR ("conversation_id" = ${ids.conversationId ?? ''} AND ${ids.conversationId ?? ''} <> ''))
      AND jsonb_array_length("tool_log") < ${MAX_TOOL_LOG_ENTRIES}
  `
}

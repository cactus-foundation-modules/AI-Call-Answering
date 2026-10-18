import { createHmac, timingSafeEqual } from 'crypto'
import { z } from 'zod'
import {
  completeCall,
  createCompletedCall,
  findCall,
  linkConversation,
  type TranscriptTurn,
} from './calls'
import { getSettings } from './settings'

// ---------------------------------------------------------------------------
// The post-call webhook: ElevenLabs tells us, a few seconds after hang-up, what
// was said. Two jobs - prove the message really came from ElevenLabs, then file
// the call.
// ---------------------------------------------------------------------------

/** How far a signature's timestamp may be from now. Generous enough for clock
 *  drift and a retry, short enough that a captured request cannot be replayed
 *  next week. */
export const SIGNATURE_TOLERANCE_SECONDS = 30 * 60

/** Checks the `ElevenLabs-Signature` header: `t=<unix seconds>,v0=<hex>`, where
 *  the hash is HMAC-SHA256 of `<t>.<raw body>` under the webhook's secret. */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!header || !secret) return false
  const parts = new Map<string, string>()
  for (const piece of header.split(',')) {
    const separator = piece.indexOf('=')
    if (separator > 0) parts.set(piece.slice(0, separator).trim(), piece.slice(separator + 1).trim())
  }
  const timestamp = parts.get('t')
  const signature = parts.get('v0')
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false

  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

const TranscriptItem = z.object({
  role: z.string(),
  message: z.string().nullish(),
  time_in_call_secs: z.number().nullish(),
}).passthrough()

const PostCallPayload = z.object({
  type: z.string(),
  data: z.object({
    agent_id: z.string(),
    conversation_id: z.string(),
    transcript: z.array(TranscriptItem).default([]),
    metadata: z.object({
      start_time_unix_secs: z.number().nullish(),
      call_duration_secs: z.number().nullish(),
      phone_call: z.object({ call_sid: z.string().nullish() }).passthrough().nullish(),
    }).passthrough().nullish(),
    analysis: z.object({ transcript_summary: z.string().nullish() }).passthrough().nullish(),
    conversation_initiation_client_data: z.object({
      dynamic_variables: z.record(z.string(), z.unknown()).nullish(),
    }).passthrough().nullish(),
  }).passthrough(),
}).passthrough()

export type PostCallPayloadType = z.infer<typeof PostCallPayload>

export function parsePostCallPayload(rawBody: string): PostCallPayloadType | null {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return null
  }
  const parsed = PostCallPayload.safeParse(json)
  return parsed.success ? parsed.data : null
}

export function toTranscript(items: PostCallPayloadType['data']['transcript']): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []
  for (const item of items) {
    const text = (item.message ?? '').trim()
    if (!text) continue
    if (item.role !== 'user' && item.role !== 'agent') continue
    turns.push({
      role: item.role === 'user' ? 'caller' : 'assistant',
      text,
      at: typeof item.time_in_call_secs === 'number' ? item.time_in_call_secs : null,
    })
  }
  return turns
}

function variable(variables: Record<string, unknown> | null | undefined, name: string): string {
  const value = variables?.[name]
  return typeof value === 'string' ? value : ''
}

/** A one-line overview when ElevenLabs sent no summary of its own. */
export function fallbackSummary(turns: TranscriptTurn[]): string {
  const first = turns.find((turn) => turn.role === 'caller')
  return first ? `The caller said: "${first.text.slice(0, 200)}"` : 'The caller did not say anything.'
}

export type IngestResult =
  | { status: 'ignored'; reason: string }
  | { status: 'filed'; callId: string }

/** Files a finished call. Calls from other agents in the same ElevenLabs
 *  workspace are ignored: a workspace webhook fires for all of them. */
export async function ingestPostCall(payload: PostCallPayloadType): Promise<IngestResult> {
  if (payload.type !== 'post_call_transcription') return { status: 'ignored', reason: 'not a transcript' }
  const { data } = payload
  const settings = await getSettings()
  if (!settings.agentId || data.agent_id !== settings.agentId) return { status: 'ignored', reason: 'another agent' }

  const variables = data.conversation_initiation_client_data?.dynamic_variables
  const callSid =
    variable(variables, 'call_sid').replace(/^unknown$/, '') ||
    variable(variables, 'system__call_sid') ||
    data.metadata?.phone_call?.call_sid ||
    ''

  let call = await findCall({ callSid: callSid || null, conversationId: data.conversation_id })
  if (!call) {
    if (!callSid) return { status: 'ignored', reason: 'no call id to file it under' }
    call = await createCompletedCall({
      callSid,
      fromNumber: variable(variables, 'system__caller_id') || variable(variables, 'caller_number').replace(/^withheld$/, ''),
      toNumber: variable(variables, 'system__called_number'),
    })
    if (!call) return { status: 'ignored', reason: 'could not open a record' }
  }

  await linkConversation(call.id, data.conversation_id)
  const transcript = toTranscript(data.transcript)
  const startSeconds = data.metadata?.start_time_unix_secs
  await completeCall(call.id, {
    conversationId: data.conversation_id,
    durationSeconds: Math.max(0, Math.round(data.metadata?.call_duration_secs ?? 0)),
    summary: (data.analysis?.transcript_summary ?? '').trim() || fallbackSummary(transcript),
    transcript,
    startedAt: typeof startSeconds === 'number' ? new Date(startSeconds * 1000) : null,
  })
  return { status: 'filed', callId: call.id }
}

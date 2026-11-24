import { createHmac, timingSafeEqual } from 'crypto'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// The OpenAI side of a GPT-Live call: proving a webhook came from OpenAI,
// accepting, rejecting and hanging up a SIP call, and writing the overview of a
// finished one. The live session itself is lib/live-session.ts.
//
// SERVER ONLY. Everything here holds the OpenAI key.
// ---------------------------------------------------------------------------

const API = 'https://api.openai.com/v1'

export class OpenAiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message)
  }
}

/** How far a webhook's timestamp may be from now. OpenAI follows the Standard
 *  Webhooks scheme, whose libraries allow five minutes. */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60

/** Checks an OpenAI webhook (Standard Webhooks): HMAC-SHA256 of
 *  `<webhook-id>.<webhook-timestamp>.<raw body>` under the base64 key after
 *  `whsec_`, sent as one or more space-separated `v1,<base64>` values. */
export function verifyOpenAiWebhook(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  secret: string | null,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false
  if (!/^\d+$/.test(headers.timestamp)) return false
  if (Math.abs(nowSeconds - Number(headers.timestamp)) > WEBHOOK_TOLERANCE_SECONDS) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  if (key.length === 0) return false
  const expected = Buffer.from(
    createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest('base64'),
  )
  for (const part of headers.signature.split(' ')) {
    const [version, value] = part.split(',', 2)
    if (version !== 'v1' || !value) continue
    const given = Buffer.from(value)
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true
  }
  return false
}

const IncomingCall = z.object({
  type: z.string(),
  data: z.object({
    // live.transport.incoming says "sip"; the older live.call.incoming has none.
    type: z.string().optional(),
    session_id: z.string().min(1).max(200),
    sip_headers: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
  }).passthrough(),
}).passthrough()

export type IncomingCallEvent = { sessionId: string; sipHeaders: Array<{ name: string; value: string }> }

/** The incoming-call webhook, or null for any other event this project's
 *  webhook happens to deliver. */
export function parseIncomingCall(rawBody: string): IncomingCallEvent | null {
  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return null
  }
  const parsed = IncomingCall.safeParse(json)
  if (!parsed.success) return null
  const { type, data } = parsed.data
  if (type !== 'live.transport.incoming' && type !== 'live.call.incoming') return null
  if (data.type && data.type !== 'sip') return null
  return { sessionId: data.session_id, sipHeaders: data.sip_headers }
}

async function post(apiKey: string, path: string, body: unknown, timeoutMs: number): Promise<Response> {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  })
}

async function failure(res: Response, what: string): Promise<OpenAiError> {
  const body = await res.json().catch(() => null) as { error?: { message?: string; code?: string } } | null
  return new OpenAiError(`${what}: ${body?.error?.message ?? `HTTP ${res.status}`}`, res.status, body?.error?.code ?? null)
}

function sessionPath(sessionId: string, action: string): string {
  return `/live/sessions/${encodeURIComponent(sessionId)}/${action}`
}

/** Starts the conversation. Returns once the session is ready; throws
 *  otherwise, including when somebody else already decided the call. */
export async function acceptCall(apiKey: string, sessionId: string, body: unknown): Promise<void> {
  const res = await post(apiKey, sessionPath(sessionId, 'accept'), body, 10_000)
  if (!res.ok) throw await failure(res, 'OpenAI would not accept the call')
}

/** Turns a call away. 480 (temporarily unavailable) sends Twilio on to the
 *  number's own forwarding and voicemail. */
export async function rejectCall(apiKey: string, sessionId: string, statusCode = 480): Promise<void> {
  const res = await post(apiKey, sessionPath(sessionId, 'reject'), { status_code: statusCode }, 5_000)
  if (!res.ok) throw await failure(res, 'OpenAI would not reject the call')
}

export async function hangUpCall(apiKey: string, sessionId: string): Promise<void> {
  const res = await post(apiKey, sessionPath(sessionId, 'hangup'), undefined, 5_000)
  if (!res.ok) throw await failure(res, 'OpenAI would not hang up the call')
}

export function attachUrl(sessionId: string): string {
  return `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`
}

const SUMMARY_INSTRUCTIONS = `You write the overview a small shop's staff read at the top of a phone call their digital assistant took. Two or three plain sentences in British English: what the caller wanted, what they were told or sent, and anything the shop still needs to do. No greeting, no bullet points, no prices or order details beyond what is needed to follow up.`

type ResponsesOutput = { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }

/** Asks the backend model for the call's overview. ElevenLabs writes its own;
 *  GPT-Live does not. The instructions come first and never change, so they
 *  are cached like the call's own prompt. Null when it cannot, and the caller
 *  falls back to the first thing the caller said. */
export async function summariseCall(apiKey: string, model: string, transcriptText: string): Promise<string | null> {
  try {
    const res = await post(apiKey, '/responses', {
      model,
      instructions: SUMMARY_INSTRUCTIONS,
      input: transcriptText.slice(0, 40_000),
      max_output_tokens: 400,
      reasoning: { effort: 'low' },
      store: false,
    }, 20_000)
    if (!res.ok) {
      console.error('[ai-call-answering] could not summarise a GPT-Live call', (await failure(res, 'summary')).message)
      return null
    }
    const body = await res.json() as ResponsesOutput
    const text = (body.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .map((part) => part.text ?? '')
      .join('')
      .trim()
    return text || null
  } catch (error) {
    console.error('[ai-call-answering] could not summarise a GPT-Live call', error)
    return null
  }
}

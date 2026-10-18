import { z } from 'zod'

// ---------------------------------------------------------------------------
// A thin ElevenLabs client: just the calls this module makes, each answer parsed
// down to the few fields we use. Nothing here knows about the shop or the phone.
//
// SERVER ONLY. It carries the API key.
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.elevenlabs.io'

/** Setup calls are made by a person waiting at a settings screen. */
const SETUP_TIMEOUT_MS = 20_000

/** The call-time registration happens while a caller listens to ringing, and
 *  Twilio itself gives up on a webhook after fifteen seconds. Anything slower
 *  than this is better handed back to forwarding and voicemail. */
export const REGISTER_CALL_TIMEOUT_MS = 6_000

export class ElevenLabsError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ElevenLabsError'
    this.status = status
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  timeoutMs?: number
}

const ErrorBody = z.object({
  detail: z.union([
    z.string(),
    z.object({ message: z.string().optional(), status: z.string().optional() }).passthrough(),
    z.array(z.object({ msg: z.string().optional(), loc: z.array(z.union([z.string(), z.number()])).optional() }).passthrough()),
  ]).optional(),
})

function describeError(status: number, raw: string): string {
  let text = raw.slice(0, 300)
  try {
    const parsed = ErrorBody.safeParse(JSON.parse(raw))
    const detail = parsed.success ? parsed.data.detail : undefined
    if (typeof detail === 'string') text = detail
    else if (Array.isArray(detail)) {
      text = detail.map((d) => `${(d.loc ?? []).join('.')}: ${d.msg ?? ''}`.trim()).join('; ')
    } else if (detail && typeof detail === 'object') text = detail.message ?? detail.status ?? text
  } catch { /* the raw text will do */ }
  if (status === 401) return 'ElevenLabs did not accept the API key.'
  if (status === 403) return `ElevenLabs refused this: ${text || 'the key may lack a permission'}.`
  if (status === 404) return `ElevenLabs could not find that: ${text}`
  if (status === 422) return `ElevenLabs did not like the settings sent: ${text}`
  if (status === 429) return 'ElevenLabs says too many requests. Try again in a minute.'
  return `ElevenLabs answered ${status}: ${text}`
}

async function send(apiKey: string, path: string, options: RequestOptions = {}): Promise<Response> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        'xi-api-key': apiKey,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs ?? SETUP_TIMEOUT_MS),
      cache: 'no-store',
    })
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
    throw new ElevenLabsError(timedOut ? 'ElevenLabs took too long to answer.' : 'Could not reach ElevenLabs.', 0)
  }
  if (!response.ok) throw new ElevenLabsError(describeError(response.status, await response.text().catch(() => '')), response.status)
  return response
}

async function sendJson<T>(apiKey: string, path: string, schema: z.ZodType<T>, options?: RequestOptions): Promise<T> {
  const response = await send(apiKey, path, options)
  const parsed = schema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) throw new ElevenLabsError('ElevenLabs answered in a shape this module does not recognise.', 502)
  return parsed.data
}

// -- voices -----------------------------------------------------------------

const VoicesResponse = z.object({
  voices: z.array(z.object({
    voice_id: z.string(),
    name: z.string(),
    category: z.string().nullish(),
    labels: z.record(z.string(), z.string()).nullish(),
  })),
})

export type VoiceChoice = { id: string; name: string; description: string }

export async function listVoices(apiKey: string): Promise<VoiceChoice[]> {
  const { voices } = await sendJson(apiKey, '/v1/voices', VoicesResponse)
  return voices
    .map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      description: [voice.labels?.accent, voice.labels?.gender, voice.labels?.descriptive ?? voice.labels?.use_case]
        .filter((part): part is string => !!part)
        .join(', '),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// -- workspace webhook (post-call) -------------------------------------------

const WebhookCreated = z.object({ webhook_id: z.string(), webhook_secret: z.string().nullish() })

export async function createPostCallWebhook(
  apiKey: string,
  name: string,
  url: string,
): Promise<{ id: string; secret: string | null }> {
  const created = await sendJson(apiKey, '/v1/workspace/webhooks', WebhookCreated, {
    method: 'POST',
    body: { settings: { auth_type: 'hmac', name, webhook_url: url } },
  })
  return { id: created.webhook_id, secret: created.webhook_secret ?? null }
}

// -- tools --------------------------------------------------------------------

const ToolResponse = z.object({ id: z.string() })

export async function createTool(apiKey: string, toolConfig: unknown): Promise<string> {
  return (await sendJson(apiKey, '/v1/convai/tools', ToolResponse, { method: 'POST', body: { tool_config: toolConfig } })).id
}

export async function updateTool(apiKey: string, toolId: string, toolConfig: unknown): Promise<void> {
  await send(apiKey, `/v1/convai/tools/${encodeURIComponent(toolId)}`, { method: 'PATCH', body: { tool_config: toolConfig } })
}

// -- agent --------------------------------------------------------------------

const AgentCreated = z.object({ agent_id: z.string() })

export async function createAgent(apiKey: string, body: unknown): Promise<string> {
  return (await sendJson(apiKey, '/v1/convai/agents/create', AgentCreated, { method: 'POST', body })).agent_id
}

export async function updateAgent(apiKey: string, agentId: string, body: unknown): Promise<void> {
  await send(apiKey, `/v1/convai/agents/${encodeURIComponent(agentId)}`, { method: 'PATCH', body })
}

/** True when the agent exists, false on a clean 404 (deleted at ElevenLabs). */
export async function agentExists(apiKey: string, agentId: string): Promise<boolean> {
  try {
    await send(apiKey, `/v1/convai/agents/${encodeURIComponent(agentId)}`)
    return true
  } catch (error) {
    if (error instanceof ElevenLabsError && error.status === 404) return false
    throw error
  }
}

// -- inbound call ---------------------------------------------------------------

export type RegisterCallInput = {
  agentId: string
  fromNumber: string
  toNumber: string
  dynamicVariables: Record<string, string>
}

/** Registers a Twilio call with the agent and returns the TwiML that connects it. */
export async function registerCall(apiKey: string, input: RegisterCallInput): Promise<string> {
  const response = await send(apiKey, '/v1/convai/twilio/register-call', {
    method: 'POST',
    timeoutMs: REGISTER_CALL_TIMEOUT_MS,
    body: {
      agent_id: input.agentId,
      from_number: input.fromNumber,
      to_number: input.toNumber,
      direction: 'inbound',
      conversation_initiation_client_data: { dynamic_variables: input.dynamicVariables },
    },
  })
  return response.text()
}

/** The TwiML ElevenLabs returns is a whole document. Twilio's voice webhook
 *  wants the inside of `<Response>`, so the wrapper is peeled off - and a reply
 *  that is not a connection at all is refused, because a handler must answer
 *  with something that connects the caller or not at all. */
export function innerTwiml(document: string): string | null {
  const match = /<Response[^>]*>([\s\S]*)<\/Response>/i.exec(document)
  const inner = match?.[1]?.trim() ?? ''
  return /<Connect[\s>]/i.test(inner) ? inner : null
}

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
    labels: z.record(z.string(), z.string().nullish()).nullish(),
    preview_url: z.string().nullish(),
  })),
})

export type VoiceChoice = {
  id: string
  name: string
  description: string
  accent: string
  gender: string
  age: string
  previewUrl: string | null
}

function describeVoice(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => !!part).join(', ')
}

/** The voices already on the account. */
export async function listVoices(apiKey: string): Promise<VoiceChoice[]> {
  const { voices } = await sendJson(apiKey, '/v1/voices', VoicesResponse)
  return voices
    .map((voice) => ({
      id: voice.voice_id,
      name: voice.name,
      description: describeVoice([voice.labels?.accent, voice.labels?.gender, voice.labels?.descriptive ?? voice.labels?.use_case]),
      accent: voice.labels?.accent?.toLowerCase() ?? '',
      gender: voice.labels?.gender?.toLowerCase() ?? '',
      age: voice.labels?.age?.toLowerCase() ?? '',
      previewUrl: voice.preview_url ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

// -- the shared voice library -------------------------------------------------
//
// ElevenLabs keeps thousands of voices beyond the handful on an account: the
// Voice Library. A library voice has to be added to the account before an agent
// can speak with it; that is one call, and the voice then shows up in listVoices.

const LibraryResponse = z.object({
  voices: z.array(z.object({
    public_owner_id: z.string(),
    voice_id: z.string(),
    name: z.string(),
    accent: z.string().nullish(),
    gender: z.string().nullish(),
    age: z.string().nullish(),
    descriptive: z.string().nullish(),
    use_case: z.string().nullish(),
    description: z.string().nullish(),
    preview_url: z.string().nullish(),
  })),
  has_more: z.boolean().nullish(),
})

export type LibraryVoice = VoiceChoice & { publicOwnerId: string }

export type LibraryFilters = {
  search: string
  accent: string
  gender: string
  age: string
  page: number
}

const LIBRARY_PAGE_SIZE = 24

export async function searchVoiceLibrary(
  apiKey: string,
  filters: LibraryFilters,
): Promise<{ voices: LibraryVoice[]; hasMore: boolean }> {
  const query = new URLSearchParams({
    page_size: String(LIBRARY_PAGE_SIZE),
    page: String(Math.max(0, filters.page)),
    sort: 'trending',
  })
  // Calls are conversation, not narration, and the library is dominated by
  // audiobook readers that sound wrong on a phone line. Not applied when
  // looking for a voice by name: "Katie" is wanted whatever she is tagged as.
  if (!filters.search.trim()) query.set('use_cases', 'conversational')
  if (filters.search.trim()) query.set('search', filters.search.trim())
  if (filters.accent) query.set('accent', filters.accent)
  if (filters.gender) query.set('gender', filters.gender)
  if (filters.age) query.set('age', filters.age)
  const result = await sendJson(apiKey, `/v1/shared-voices?${query.toString()}`, LibraryResponse)
  return {
    hasMore: result.has_more === true,
    voices: result.voices.map((voice) => ({
      id: voice.voice_id,
      publicOwnerId: voice.public_owner_id,
      name: voice.name,
      description: describeVoice([voice.accent, voice.gender, voice.descriptive ?? voice.use_case]),
      accent: voice.accent?.toLowerCase() ?? '',
      gender: voice.gender?.toLowerCase() ?? '',
      age: voice.age?.toLowerCase() ?? '',
      previewUrl: voice.preview_url ?? null,
    })),
  }
}

const AddedVoice = z.object({ voice_id: z.string() })

/** Adds a library voice to the account and returns the id to speak with. */
export async function addLibraryVoice(
  apiKey: string,
  voice: { publicOwnerId: string; voiceId: string; name: string },
): Promise<string> {
  const added = await sendJson(
    apiKey,
    `/v1/voices/add/${encodeURIComponent(voice.publicOwnerId)}/${encodeURIComponent(voice.voiceId)}`,
    AddedVoice,
    { method: 'POST', body: { new_name: voice.name } },
  )
  return added.voice_id
}

const VoiceDetail = z.object({
  name: z.string(),
  sharing: z.object({
    public_owner_id: z.string().nullish(),
    original_voice_id: z.string().nullish(),
  }).nullish(),
})

/** Where a voice on this account came from in the shared library, or null when
 *  it did not come from there (a cloned or premade voice has no library entry). */
export async function findLibraryOrigin(
  apiKey: string,
  voiceId: string,
): Promise<{ publicOwnerId: string; voiceId: string; name: string } | null> {
  const voice = await sendJson(apiKey, `/v1/voices/${encodeURIComponent(voiceId)}`, VoiceDetail)
  const owner = voice.sharing?.public_owner_id
  const original = voice.sharing?.original_voice_id
  return owner && original ? { publicOwnerId: owner, voiceId: original, name: voice.name } : null
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

const WebhookList = z.object({ webhooks: z.array(z.object({ webhook_id: z.string() })).default([]) })

/** Whether this account still holds the webhook. Ids belong to one account, so
 *  after the API key is swapped for another account's the stored id points at
 *  nothing and the agent cannot be made against it. */
export async function postCallWebhookExists(apiKey: string, webhookId: string): Promise<boolean> {
  const list = await sendJson(apiKey, '/v1/workspace/webhooks', WebhookList)
  return (list.webhooks ?? []).some((webhook) => webhook.webhook_id === webhookId)
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

// -- credit -----------------------------------------------------------------
//
// register-call accepts a call for an account with no credit left, and
// ElevenLabs then drops the caller a second or two in. Asking the account for its
// allowance first lets the call go to the next key, or to voicemail, instead.

const SubscriptionResponse = z.object({
  character_count: z.number().optional(),
  character_limit: z.number().optional(),
  can_extend_character_limit: z.boolean().nullish(),
})

/** Below this share of the allowance an account is treated as spent. ElevenLabs
 *  takes a call from an account that is nearly empty and drops it a few seconds
 *  in, which is worse for the caller than passing over the key. */
export const LOW_CREDIT_SHARE = 0.02

/** True when the account has used all its credit and may not go over, or has so
 *  little left that a call would not finish. Null when
 *  that cannot be told (key lacks permission to read it, ElevenLabs slow): the
 *  caller then carries on and tries the call. */
export async function isOutOfCredit(apiKey: string, timeoutMs = 2_000): Promise<boolean | null> {
  try {
    const sub = await sendJson(apiKey, '/v1/user/subscription', SubscriptionResponse, { timeoutMs })
    if (typeof sub.character_count !== 'number' || typeof sub.character_limit !== 'number') return null
    if (sub.character_limit <= 0) return null
    if (sub.can_extend_character_limit === true) return false
    return sub.character_limit - sub.character_count <= sub.character_limit * LOW_CREDIT_SHARE
  } catch {
    return null
  }
}

// -- inbound call ---------------------------------------------------------------

export type RegisterCallInput = {
  agentId: string
  fromNumber: string
  toNumber: string
  dynamicVariables: Record<string, string>
  /** Defaults to REGISTER_CALL_TIMEOUT_MS; shorter when an earlier key has used some of the time. */
  timeoutMs?: number
}

/** Registers a Twilio call with the agent and returns the TwiML that connects it. */
export async function registerCall(apiKey: string, input: RegisterCallInput): Promise<string> {
  const response = await send(apiKey, '/v1/convai/twilio/register-call', {
    method: 'POST',
    timeoutMs: input.timeoutMs ?? REGISTER_CALL_TIMEOUT_MS,
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

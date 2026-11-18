import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'

// ---------------------------------------------------------------------------
// Module settings, resolved env-first.
//
// The ElevenLabs key can come from an env var (a pre-provisioned install never
// opens the settings screen) or from the singleton row, encrypted. Env wins, so
// rotating the env var can never be shadowed by a stale row.
// ---------------------------------------------------------------------------

/** The newest, most natural-sounding ElevenLabs model that agents can speak with
 *  at the time of writing. `eleven_v4_turbo` is the quicker, cheaper sibling and
 *  is on the menu; `eleven_flash_v2_5` is the lowest-latency older option. */
export const DEFAULT_TTS_MODEL = 'eleven_v4'

export const TTS_MODEL_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'eleven_v4', label: 'Eleven v4 - the most lifelike (recommended)' },
  { id: 'eleven_v4_turbo', label: 'Eleven v4 Turbo - nearly as lifelike, quicker to answer' },
  { id: 'eleven_v3_conversational', label: 'Eleven v3 Conversational - expressive, the previous generation' },
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5 - the fastest, noticeably less natural' },
]

/** The model that does the thinking. A phone call is unforgiving of slow
 *  answers, but product and order questions are unforgiving of wrong ones. */
export const DEFAULT_LLM = 'claude-sonnet-5-5'

export const LLM_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 - careful and quick (recommended)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 - quickest, cheapest' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 - most thorough, slowest' },
]

/** A British voice that exists on every ElevenLabs account ("Alice"). The
 *  settings screen lists the account's real voices, so this is only where a
 *  fresh install starts. */
export const DEFAULT_VOICE_ID = 'Xb7hH8MSUJpSbSDYk0k2'

export const LANGUAGE_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'en', label: 'English' },
  { id: 'cy', label: 'Welsh' },
  { id: 'fr', label: 'French' },
  { id: 'de', label: 'German' },
  { id: 'es', label: 'Spanish' },
  { id: 'pl', label: 'Polish' },
]

export const MAX_CALL_MINUTES_LIMIT = 60

// ---------------------------------------------------------------------------
// GPT-Live, the second engine. OpenAI's own voice model answers the call and
// hands the thinking and the lookups to a backend model (lib/live-config.ts).
// ---------------------------------------------------------------------------

export const ENGINES = ['elevenlabs', 'gpt-live'] as const
export type Engine = (typeof ENGINES)[number]

export function isEngine(value: unknown): value is Engine {
  return typeof value === 'string' && (ENGINES as readonly string[]).includes(value)
}

export const ENGINE_CHOICES: ReadonlyArray<{ id: Engine; label: string }> = [
  { id: 'elevenlabs', label: 'ElevenLabs - your choice of voice and thinking model (recommended)' },
  { id: 'gpt-live', label: 'OpenAI GPT-Live 1 - listens while it talks, so callers can butt in naturally' },
]

/** `gpt-live-1` is the only voice model OpenAI lists. Kept in one place so a
 *  1.1 is a one-line change. */
export const LIVE_MODEL = 'gpt-live-1'

export const DEFAULT_LIVE_VOICE = 'marin'

export type LiveVoiceChoice = {
  id: string
  label: string
  /** Heading the voice sits under in the picker. */
  group: string
  /** What OpenAI says about it, in a few words. Empty where OpenAI says nothing. */
  description: string
}

/** Every built-in GPT-Live voice, as the accept endpoint's reference lists them
 *  (38 on 2026-11-18). Descriptions come from OpenAI's Live voice table and its
 *  text-to-speech guide; voices neither describes say so rather than guess.
 *  Ordered for a British shop: British and Irish first. The picker also takes
 *  the id of a custom voice made in the OpenAI project. */
export const LIVE_VOICE_CHOICES: ReadonlyArray<LiveVoiceChoice> = [
  { id: 'vesper', label: 'Vesper', group: 'British and Irish English', description: 'British, masculine, natural' },
  { id: 'willow', label: 'Willow', group: 'British and Irish English', description: 'Irish, feminine, natural' },
  { id: 'stone', label: 'Stone', group: 'British and Irish English', description: 'Irish, masculine, natural' },

  { id: 'marin', label: 'Marin', group: 'OpenAI standard voices (English)', description: 'OpenAI default, one of its two best-quality voices' },
  { id: 'cedar', label: 'Cedar', group: 'OpenAI standard voices (English)', description: 'One of OpenAI\u2019s two best-quality voices' },
  { id: 'alloy', label: 'Alloy', group: 'OpenAI standard voices (English)', description: '' },
  { id: 'ash', label: 'Ash', group: 'OpenAI standard voices (English)', description: '' },
  { id: 'ballad', label: 'Ballad', group: 'OpenAI standard voices (English)', description: '' },
  { id: 'coral', label: 'Coral', group: 'OpenAI standard voices (English)', description: '' },
  { id: 'echo', label: 'Echo', group: 'OpenAI standard voices (English)', description: '' },
  { id: 'sage', label: 'Sage', group: 'OpenAI standard voices (English)', description: '' },
  { id: 'shimmer', label: 'Shimmer', group: 'OpenAI standard voices (English)', description: '' },
  { id: 'verse', label: 'Verse', group: 'OpenAI standard voices (English)', description: '' },

  { id: 'quartz', label: 'Quartz', group: 'Other English accents', description: 'Australian, feminine, generated' },
  { id: 'ripple', label: 'Ripple', group: 'Other English accents', description: 'Australian, masculine, natural' },
  { id: 'gleam', label: 'Gleam', group: 'Other English accents', description: 'North American, feminine, natural' },
  { id: 'meridian', label: 'Meridian', group: 'Other English accents', description: 'North American, masculine, natural' },
  { id: 'delta', label: 'Delta', group: 'Other English accents', description: 'Southern US, feminine, generated' },
  { id: 'cinder', label: 'Cinder', group: 'Other English accents', description: 'Southern US, masculine, generated' },
  { id: 'beacon', label: 'Beacon', group: 'Other English accents', description: 'Filipino, masculine, generated' },

  { id: 'brise', label: 'Brise', group: 'Other languages', description: 'French, feminine, natural' },
  { id: 'sillage', label: 'Sillage', group: 'Other languages', description: 'French, masculine, natural' },
  { id: 'nuri', label: 'Nuri', group: 'Other languages', description: 'German, feminine, natural' },
  { id: 'juni', label: 'Juni', group: 'Other languages', description: 'German, feminine, natural' },
  { id: 'flitz', label: 'Flitz', group: 'Other languages', description: 'German, masculine, natural' },
  { id: 'bossa', label: 'Bossa', group: 'Other languages', description: 'Brazilian Portuguese, feminine, natural' },
  { id: 'tempo', label: 'Tempo', group: 'Other languages', description: 'Brazilian Portuguese, masculine, natural' },
  { id: 'nira', label: 'Nira', group: 'Other languages', description: 'Hindi, feminine, natural' },
  { id: 'harema', label: 'Harema', group: 'Other languages', description: 'Japanese, feminine, natural' },
  { id: 'shida', label: 'Shida', group: 'Other languages', description: 'Japanese, masculine, natural' },
  { id: 'noeul', label: 'Noeul', group: 'Other languages', description: 'Korean, feminine, natural' },

  { id: 'calandria', label: 'Calandria', group: 'Not yet described by OpenAI', description: '' },
  { id: 'compas', label: 'Compas', group: 'Not yet described by OpenAI', description: '' },
  { id: 'destello', label: 'Destello', group: 'Not yet described by OpenAI', description: '' },
  { id: 'halo', label: 'Halo', group: 'Not yet described by OpenAI', description: '' },
  { id: 'hornero', label: 'Hornero', group: 'Not yet described by OpenAI', description: '' },
  { id: 'luciernaga', label: 'Luciernaga', group: 'Not yet described by OpenAI', description: '' },
  { id: 'pearl', label: 'Pearl', group: 'Not yet described by OpenAI', description: '' },
]

export function isBuiltInLiveVoice(id: string): boolean {
  return LIVE_VOICE_CHOICES.some((voice) => voice.id === id)
}

/** The backend model GPT-Live hands questions and lookups to. OpenAI suggests
 *  starting with Luna and moving to Sol for harder work. */
export const DEFAULT_LIVE_BACKEND_MODEL = 'gpt-6-luna'

export const LIVE_BACKEND_MODEL_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna - quick, OpenAI\'s suggested start (recommended)' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol - more careful with tricky questions, a little slower' },
]

export const LIVE_REGIONS = ['global', 'eu', 'in'] as const
export type LiveRegion = (typeof LIVE_REGIONS)[number]

export const LIVE_REGION_CHOICES: ReadonlyArray<{ id: LiveRegion; label: string }> = [
  { id: 'global', label: 'Nearest to the caller' },
  { id: 'eu', label: 'Europe only' },
  { id: 'in', label: 'India only' },
]

function isLiveRegion(value: unknown): value is LiveRegion {
  return typeof value === 'string' && (LIVE_REGIONS as readonly string[]).includes(value)
}

export type AiCallSettings = {
  enabled: boolean
  apiKey: string | null
  apiKeyFromEnv: boolean
  agentId: string | null
  voiceId: string
  ttsModel: string
  llm: string
  language: string
  businessName: string
  greeting: string
  extraInstructions: string
  emailSignature: string
  maxCallMinutes: number
  postCallWebhookId: string | null
  webhookSecret: string | null
  toolsToken: string | null
  toolIds: Record<string, string>
  syncedHash: string
  syncedAt: Date | null
  engine: Engine
  openaiApiKey: string | null
  openaiApiKeyFromEnv: boolean
  openaiProjectId: string
  openaiWebhookSecret: string | null
  liveVoice: string
  liveBackendModel: string
  liveRegion: LiveRegion
  /** Play a quiet typing loop to the caller while the thinking model works.
   *  Puts GPT-Live calls through a Twilio conference (lib/live-conference.ts). */
  liveTypingSound: boolean
}

type Row = Record<string, unknown>

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function toolIdMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [name, id] of Object.entries(value as Record<string, unknown>)) {
    if (typeof id === 'string' && id) out[name] = id
  }
  return out
}

export function envApiKey(): string | null {
  return str(process.env.ELEVENLABS_API_KEY)
}

export function envOpenAiKey(): string | null {
  return str(process.env.OPENAI_API_KEY)
}

async function readRow(): Promise<Row | null> {
  const rows = await prisma.$queryRaw<Row[]>`SELECT * FROM "acall_settings" WHERE "id" = 'singleton' LIMIT 1`
  return rows[0] ?? null
}

export async function getSettings(): Promise<AiCallSettings> {
  const row = await readRow()
  const fromEnv = envApiKey()
  const openaiFromEnv = envOpenAiKey()
  const minutes = typeof row?.max_call_minutes === 'number' ? row.max_call_minutes : 15
  return {
    enabled: row?.enabled === true,
    // tryDecryptSecret: a restored backup carries ciphertext written under
    // another install's key, and "cannot read that" is a missing key.
    apiKey: fromEnv ?? tryDecryptSecret(str(row?.api_key_encrypted)),
    apiKeyFromEnv: !!fromEnv,
    agentId: str(row?.agent_id),
    voiceId: str(row?.voice_id) ?? DEFAULT_VOICE_ID,
    ttsModel: str(row?.tts_model) ?? DEFAULT_TTS_MODEL,
    llm: str(row?.llm) ?? DEFAULT_LLM,
    language: str(row?.language) ?? 'en',
    businessName: str(row?.business_name) ?? '',
    greeting: str(row?.greeting) ?? '',
    extraInstructions: str(row?.extra_instructions) ?? '',
    emailSignature: str(row?.email_signature) ?? '',
    maxCallMinutes: Math.min(Math.max(minutes, 1), MAX_CALL_MINUTES_LIMIT),
    postCallWebhookId: str(row?.post_call_webhook_id),
    webhookSecret: tryDecryptSecret(str(row?.webhook_secret_encrypted)),
    toolsToken: tryDecryptSecret(str(row?.tools_token_encrypted)),
    toolIds: toolIdMap(row?.tool_ids),
    syncedHash: str(row?.synced_hash) ?? '',
    syncedAt: row?.synced_at instanceof Date ? row.synced_at : null,
    engine: isEngine(row?.engine) ? row.engine : 'elevenlabs',
    openaiApiKey: openaiFromEnv ?? tryDecryptSecret(str(row?.openai_api_key_encrypted)),
    openaiApiKeyFromEnv: !!openaiFromEnv,
    openaiProjectId: str(row?.openai_project_id) ?? '',
    openaiWebhookSecret: tryDecryptSecret(str(row?.openai_webhook_secret_encrypted)),
    liveVoice: str(row?.live_voice) ?? DEFAULT_LIVE_VOICE,
    liveBackendModel: str(row?.live_backend_model) ?? DEFAULT_LIVE_BACKEND_MODEL,
    liveRegion: isLiveRegion(row?.live_region) ? row.live_region : 'global',
    liveTypingSound: row?.live_typing_sound === true,
  }
}

/** Whether GPT-Live has everything a call needs: a key to accept it with, the
 *  project the SIP address names, and the secret that proves a webhook came
 *  from OpenAI. Nothing is made on OpenAI's side in advance, so this is the
 *  whole of "set up". */
export function liveReady(settings: AiCallSettings): boolean {
  return !!settings.openaiApiKey && /^proj_[A-Za-z0-9]+$/.test(settings.openaiProjectId) && !!settings.openaiWebhookSecret
}

/** Whether the chosen engine can take a call. */
export function engineReady(settings: AiCallSettings): boolean {
  return settings.engine === 'gpt-live' ? liveReady(settings) : !!settings.agentId
}

async function ensureRow(): Promise<void> {
  await prisma.$executeRaw`INSERT INTO "acall_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING`
}

export type SettingsPatch = {
  enabled?: boolean
  apiKey?: string
  clearApiKey?: boolean
  voiceId?: string
  ttsModel?: string
  llm?: string
  language?: string
  businessName?: string
  greeting?: string
  extraInstructions?: string
  emailSignature?: string
  maxCallMinutes?: number
  engine?: Engine
  openaiApiKey?: string
  clearOpenaiApiKey?: boolean
  openaiProjectId?: string
  openaiWebhookSecret?: string
  liveVoice?: string
  liveBackendModel?: string
  liveRegion?: LiveRegion
  liveTypingSound?: boolean
}

/** Written a column at a time: every value is optional, and a template literal
 *  cannot build a SET list without losing the parameterisation. */
export async function updateSettings(patch: SettingsPatch): Promise<void> {
  await ensureRow()
  if (patch.clearApiKey) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "api_key_encrypted" = NULL WHERE "id" = 'singleton'`
  } else if (patch.apiKey) {
    const encrypted = encryptSecret(patch.apiKey.trim())
    await prisma.$executeRaw`UPDATE "acall_settings" SET "api_key_encrypted" = ${encrypted} WHERE "id" = 'singleton'`
  }
  if (patch.enabled !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "enabled" = ${patch.enabled} WHERE "id" = 'singleton'`
  }
  if (patch.voiceId !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "voice_id" = ${patch.voiceId.trim()} WHERE "id" = 'singleton'`
  }
  if (patch.ttsModel !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "tts_model" = ${patch.ttsModel.trim() || DEFAULT_TTS_MODEL} WHERE "id" = 'singleton'`
  }
  if (patch.llm !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "llm" = ${patch.llm.trim() || DEFAULT_LLM} WHERE "id" = 'singleton'`
  }
  if (patch.language !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "language" = ${patch.language.trim() || 'en'} WHERE "id" = 'singleton'`
  }
  if (patch.businessName !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "business_name" = ${patch.businessName.trim()} WHERE "id" = 'singleton'`
  }
  if (patch.greeting !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "greeting" = ${patch.greeting.trim()} WHERE "id" = 'singleton'`
  }
  if (patch.extraInstructions !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "extra_instructions" = ${patch.extraInstructions.trim()} WHERE "id" = 'singleton'`
  }
  if (patch.emailSignature !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "email_signature" = ${patch.emailSignature.trim()} WHERE "id" = 'singleton'`
  }
  if (patch.maxCallMinutes !== undefined) {
    const minutes = Math.min(Math.max(Math.round(patch.maxCallMinutes), 1), MAX_CALL_MINUTES_LIMIT)
    await prisma.$executeRaw`UPDATE "acall_settings" SET "max_call_minutes" = ${minutes} WHERE "id" = 'singleton'`
  }
  if (patch.engine !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "engine" = ${patch.engine} WHERE "id" = 'singleton'`
  }
  if (patch.clearOpenaiApiKey) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "openai_api_key_encrypted" = NULL WHERE "id" = 'singleton'`
  } else if (patch.openaiApiKey) {
    const encrypted = encryptSecret(patch.openaiApiKey.trim())
    await prisma.$executeRaw`UPDATE "acall_settings" SET "openai_api_key_encrypted" = ${encrypted} WHERE "id" = 'singleton'`
  }
  if (patch.openaiProjectId !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "openai_project_id" = ${patch.openaiProjectId.trim()} WHERE "id" = 'singleton'`
  }
  if (patch.openaiWebhookSecret) {
    const encrypted = encryptSecret(patch.openaiWebhookSecret.trim())
    await prisma.$executeRaw`UPDATE "acall_settings" SET "openai_webhook_secret_encrypted" = ${encrypted} WHERE "id" = 'singleton'`
  }
  if (patch.liveVoice !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "live_voice" = ${patch.liveVoice.trim() || DEFAULT_LIVE_VOICE} WHERE "id" = 'singleton'`
  }
  if (patch.liveBackendModel !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "live_backend_model" = ${patch.liveBackendModel.trim() || DEFAULT_LIVE_BACKEND_MODEL} WHERE "id" = 'singleton'`
  }
  if (patch.liveRegion !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "live_region" = ${patch.liveRegion} WHERE "id" = 'singleton'`
  }
  if (patch.liveTypingSound !== undefined) {
    await prisma.$executeRaw`UPDATE "acall_settings" SET "live_typing_sound" = ${patch.liveTypingSound} WHERE "id" = 'singleton'`
  }
  await prisma.$executeRaw`UPDATE "acall_settings" SET "updated_at" = CURRENT_TIMESTAMP WHERE "id" = 'singleton'`
}

/** What a successful "set up the assistant" remembers. Written as one unit so a
 *  half-finished setup never leaves an agent id without its tools. */
export type ProvisionedState = {
  agentId: string
  postCallWebhookId: string
  webhookSecret: string | null
  toolsToken: string
  toolIds: Record<string, string>
  syncedHash: string
}

export async function saveProvisionedState(state: ProvisionedState): Promise<void> {
  await ensureRow()
  const toolsToken = encryptSecret(state.toolsToken)
  const webhookSecret = state.webhookSecret ? encryptSecret(state.webhookSecret) : null
  const toolIds = JSON.stringify(state.toolIds)
  await prisma.$executeRaw`
    UPDATE "acall_settings" SET
      "agent_id" = ${state.agentId},
      "post_call_webhook_id" = ${state.postCallWebhookId},
      "webhook_secret_encrypted" = COALESCE(${webhookSecret}::text, "webhook_secret_encrypted"),
      "tools_token_encrypted" = ${toolsToken},
      "tool_ids" = ${toolIds}::jsonb,
      "synced_hash" = ${state.syncedHash},
      "synced_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
}

/** Kept the moment ElevenLabs hands it over: the signing secret is shown once,
 *  and a setup that failed on a later step must not lose it and make a second
 *  webhook next time. */
export async function saveWebhook(webhookId: string, secret: string): Promise<void> {
  await ensureRow()
  const encrypted = encryptSecret(secret)
  await prisma.$executeRaw`
    UPDATE "acall_settings" SET
      "post_call_webhook_id" = ${webhookId},
      "webhook_secret_encrypted" = ${encrypted},
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = 'singleton'
  `
}

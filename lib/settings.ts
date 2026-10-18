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

async function readRow(): Promise<Row | null> {
  const rows = await prisma.$queryRaw<Row[]>`SELECT * FROM "acall_settings" WHERE "id" = 'singleton' LIMIT 1`
  return rows[0] ?? null
}

export async function getSettings(): Promise<AiCallSettings> {
  const row = await readRow()
  const fromEnv = envApiKey()
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
  }
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

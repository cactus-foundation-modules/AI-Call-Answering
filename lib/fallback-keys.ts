import { prisma } from '@/lib/db/prisma'
import { encryptSecret, tryDecryptSecret } from '@/lib/crypto/secrets'
import { ElevenLabsError } from './elevenlabs'
import type { AiCallSettings } from './settings'

// ---------------------------------------------------------------------------
// Fallback ElevenLabs keys.
//
// Credit runs out per ElevenLabs account, so a fallback is a second account,
// with its own agent, tools and post-call webhook. A call is offered to the
// main key first and then to each fallback in turn; the first that connects
// takes it. If none does, the number's forwarding and voicemail take over, as
// they always have.
// ---------------------------------------------------------------------------

export const MAX_FALLBACK_KEYS = 5

export type FallbackKey = {
  id: string
  label: string
  apiKey: string | null
  agentId: string | null
  postCallWebhookId: string | null
  webhookSecret: string | null
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

export async function listFallbackKeys(): Promise<FallbackKey[]> {
  const rows = await prisma.$queryRaw<Row[]>`SELECT * FROM "acall_fallback_keys" ORDER BY "position", "created_at", "id"`
  return rows.map((row) => ({
    id: String(row.id),
    label: str(row.label) ?? '',
    apiKey: tryDecryptSecret(str(row.api_key_encrypted)),
    agentId: str(row.agent_id),
    postCallWebhookId: str(row.post_call_webhook_id),
    webhookSecret: tryDecryptSecret(str(row.webhook_secret_encrypted)),
    toolIds: toolIdMap(row.tool_ids),
    syncedHash: str(row.synced_hash) ?? '',
    syncedAt: row.synced_at instanceof Date ? row.synced_at : null,
  }))
}

/** False when the list is already full. */
export async function addFallbackKey(label: string, apiKey: string): Promise<boolean> {
  const counted = await prisma.$queryRaw<Array<{ n: bigint | number }>>`SELECT COUNT(*) AS n FROM "acall_fallback_keys"`
  const count = Number(counted[0]?.n ?? 0)
  if (count >= MAX_FALLBACK_KEYS) return false
  const encrypted = encryptSecret(apiKey.trim())
  await prisma.$executeRaw`
    INSERT INTO "acall_fallback_keys" ("label", "api_key_encrypted", "position")
    VALUES (${label.trim()}, ${encrypted}, ${count})
  `
  return true
}

export async function removeFallbackKey(id: string): Promise<void> {
  await prisma.$executeRaw`DELETE FROM "acall_fallback_keys" WHERE "id" = ${id}`
}

/** Kept the moment ElevenLabs hands the signing secret over (shown once). */
export async function saveFallbackWebhook(id: string, webhookId: string, secret: string): Promise<void> {
  const encrypted = encryptSecret(secret)
  await prisma.$executeRaw`
    UPDATE "acall_fallback_keys" SET "post_call_webhook_id" = ${webhookId}, "webhook_secret_encrypted" = ${encrypted}
    WHERE "id" = ${id}
  `
}

export async function saveFallbackProvisioned(
  id: string,
  state: { agentId: string; toolIds: Record<string, string>; syncedHash: string },
): Promise<void> {
  const toolIds = JSON.stringify(state.toolIds)
  await prisma.$executeRaw`
    UPDATE "acall_fallback_keys" SET
      "agent_id" = ${state.agentId},
      "tool_ids" = ${toolIds}::jsonb,
      "synced_hash" = ${state.syncedHash},
      "synced_at" = CURRENT_TIMESTAMP
    WHERE "id" = ${id}
  `
}

// -- choosing who answers -----------------------------------------------------

export type CallCandidate = { id: string; apiKey: string; agentId: string }

/** The main key first, then each fallback that has been set up. */
export function callCandidates(settings: AiCallSettings, fallbacks: FallbackKey[]): CallCandidate[] {
  const out: CallCandidate[] = []
  if (settings.apiKey && settings.agentId) out.push({ id: 'main', apiKey: settings.apiKey, agentId: settings.agentId })
  for (const fallback of fallbacks) {
    if (fallback.apiKey && fallback.agentId) out.push({ id: fallback.id, apiKey: fallback.apiKey, agentId: fallback.agentId })
  }
  return out
}

/** How long a key that ElevenLabs refused is tried last. Long enough that every
 *  call does not spend its ringing time on a key that is out of credit, short
 *  enough that topping it up brings it back within minutes. */
export const COOLDOWN_MS = 5 * 60_000

/** Statuses that mean "this key cannot take calls right now": rejected, out of
 *  credit or plan, forbidden, or over its concurrency limit. */
export function isKeyProblem(error: unknown): boolean {
  return error instanceof ElevenLabsError && [401, 402, 403, 429].includes(error.status)
}

const coolingUntil = new Map<string, number>()

export function markKeyRefused(id: string, now: number = Date.now()): void {
  coolingUntil.set(id, now + COOLDOWN_MS)
}

/** Candidates that are not cooling down keep their order and go first; the
 *  cooling ones follow, so a call still has somewhere to go if all are refused. */
export function orderCandidates(
  candidates: CallCandidate[],
  cooling: ReadonlyMap<string, number> = coolingUntil,
  now: number = Date.now(),
): CallCandidate[] {
  const isCooling = (c: CallCandidate) => (cooling.get(c.id) ?? 0) > now
  return [...candidates.filter((c) => !isCooling(c)), ...candidates.filter(isCooling)]
}

/** Every signing secret a finished-call webhook may legitimately use. */
export function webhookSecrets(settings: AiCallSettings, fallbacks: FallbackKey[]): string[] {
  return [settings.webhookSecret, ...fallbacks.map((f) => f.webhookSecret)].filter((s): s is string => !!s)
}

/** Every agent whose finished calls belong to this site. */
export function knownAgentIds(settings: AiCallSettings, fallbacks: FallbackKey[]): string[] {
  return [settings.agentId, ...fallbacks.map((f) => f.agentId)].filter((s): s is string => !!s)
}

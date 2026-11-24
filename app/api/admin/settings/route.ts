// GET/PATCH /api/m/ai-call-answering/admin/settings - the module's settings.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSiteUrl } from '@/lib/config/env'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { assistantNeedsSetup, autoResyncDue, fallbackNeedsSetup, postCallWebhookUrl } from '@/modules/ai-call-answering/lib/agent-sync'
import { MAX_FALLBACK_KEYS, listFallbackKeys } from '@/modules/ai-call-answering/lib/fallback-keys'
import { EXTRA_INSTRUCTIONS_MAX_LENGTH } from '@/modules/ai-call-answering/lib/instruction-conflicts'
import {
  ENGINES,
  ENGINE_CHOICES,
  LANGUAGE_CHOICES,
  LIVE_BACKEND_MODEL_CHOICES,
  LIVE_REGIONS,
  LIVE_REGION_CHOICES,
  LIVE_VOICE_CHOICES,
  LLM_CHOICES,
  MAX_CALL_MINUTES_LIMIT,
  SILENCE_HANG_UP_MAX_SECONDS,
  SILENCE_HANG_UP_MIN_SECONDS,
  TTS_MODEL_CHOICES,
  engineReady,
  getSettings,
  liveReady,
  updateSettings,
} from '@/modules/ai-call-answering/lib/settings'

/** Where the owner points the OpenAI project's webhook. */
function liveWebhookUrl(siteUrl: string): string {
  return `${siteUrl}/api/m/ai-call-answering/webhooks/openai-live`
}

async function guard() {
  const user = await getSessionFromCookie()
  if (!user) return { error: errorResponse('Not authenticated', 401) }
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return { error: errorResponse('Forbidden', 403) }
  return { user }
}

async function currentState() {
  const settings = await getSettings()
  const siteUrl = getSiteUrl()
  const fallbacks = await listFallbackKeys()
  return {
    enabled: settings.enabled,
    // The key itself never goes back to the browser - only whether there is one.
    hasApiKey: !!settings.apiKey,
    apiKeyFromEnv: settings.apiKeyFromEnv,
    voiceId: settings.voiceId,
    ttsModel: settings.ttsModel,
    llm: settings.llm,
    language: settings.language,
    businessName: settings.businessName,
    greeting: settings.greeting,
    extraInstructions: settings.extraInstructions,
    emailSignature: settings.emailSignature,
    maxCallMinutes: settings.maxCallMinutes,
    silenceHangUpSeconds: settings.silenceHangUpSeconds,
    agentId: settings.agentId,
    isSetUp: !!settings.agentId,
    needsSetup: assistantNeedsSetup(settings, siteUrl) || fallbacks.some((f) => fallbackNeedsSetup(settings, f, siteUrl)),
    // Out of date only because the module was updated: the hourly job pushes it.
    updatePending: autoResyncDue(settings, fallbacks, siteUrl),
    // Never the keys themselves.
    fallbackKeys: fallbacks.map((f) => ({
      id: f.id,
      label: f.label,
      isSetUp: !!f.agentId,
      needsSetup: fallbackNeedsSetup(settings, f, siteUrl),
    })),
    maxFallbackKeys: MAX_FALLBACK_KEYS,
    syncedAt: settings.syncedAt ? settings.syncedAt.toISOString() : null,
    webhookUrl: postCallWebhookUrl(siteUrl),
    ttsModels: TTS_MODEL_CHOICES,
    llms: LLM_CHOICES,
    languages: LANGUAGE_CHOICES,
    maxCallMinutesLimit: MAX_CALL_MINUTES_LIMIT,
    silenceHangUpMinSeconds: SILENCE_HANG_UP_MIN_SECONDS,
    silenceHangUpMaxSeconds: SILENCE_HANG_UP_MAX_SECONDS,
    engine: settings.engine,
    engines: ENGINE_CHOICES,
    // As with ElevenLabs: whether there is a key and a secret, never the values.
    hasOpenaiApiKey: !!settings.openaiApiKey,
    openaiApiKeyFromEnv: settings.openaiApiKeyFromEnv,
    openaiProjectId: settings.openaiProjectId,
    hasOpenaiWebhookSecret: !!settings.openaiWebhookSecret,
    liveVoice: settings.liveVoice,
    liveBackendModel: settings.liveBackendModel,
    liveRegion: settings.liveRegion,
    liveTypingSound: settings.liveTypingSound,
    liveReady: liveReady(settings),
    liveVoices: LIVE_VOICE_CHOICES,
    liveBackendModels: LIVE_BACKEND_MODEL_CHOICES,
    liveRegions: LIVE_REGION_CHOICES,
    liveWebhookUrl: liveWebhookUrl(siteUrl),
  }
}

export async function GET() {
  const { error } = await guard()
  if (error) return error
  return NextResponse.json(await currentState(), { headers: { 'Cache-Control': 'no-store' } })
}

const FIELD_LABELS: Record<string, string> = {
  apiKey: 'API key',
  voiceId: 'Voice',
  ttsModel: 'Voice model',
  llm: 'Language model',
  language: 'Language',
  businessName: 'Business name',
  greeting: 'Greeting',
  extraInstructions: 'Extra instructions',
  emailSignature: 'Email signature',
  maxCallMinutes: 'Maximum call length',
  silenceHangUpSeconds: 'Hang up after silence',
  enabled: 'Switch on/off',
  clearApiKey: 'Clear API key',
  engine: 'Voice engine',
  openaiApiKey: 'OpenAI API key',
  clearOpenaiApiKey: 'Clear OpenAI API key',
  openaiProjectId: 'OpenAI project ID',
  openaiWebhookSecret: 'OpenAI webhook signing secret',
  liveVoice: 'GPT-Live voice',
  liveBackendModel: 'GPT-Live thinking model',
  liveRegion: 'GPT-Live region',
  liveTypingSound: 'Typing sound',
}

/** Spells out which field failed and why, instead of a blanket "did not make sense". */
function describeIssue(issue: z.ZodIssue): string {
  const key = String(issue.path[0] ?? '')
  const label = FIELD_LABELS[key] ?? (key || 'Settings')
  switch (issue.code) {
    case 'too_big':
      return issue.type === 'string'
        ? `${label} is too long (${issue.maximum} characters at most).`
        : `${label} must be ${issue.maximum} or less.`
    case 'too_small':
      return issue.type === 'string'
        ? `${label} cannot be empty.`
        : `${label} must be ${issue.minimum} or more.`
    case 'invalid_type':
      return issue.received === 'undefined' || issue.received === 'null'
        ? `${label} is missing.`
        : `${label} is the wrong kind of value (expected ${issue.expected}, got ${issue.received}).`
    default:
      return `${label}: ${issue.message}`
  }
}

const Body = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.string().trim().min(1).max(500).optional(),
  clearApiKey: z.boolean().optional(),
  voiceId: z.string().trim().min(1).max(100).optional(),
  ttsModel: z.string().trim().min(1).max(100).optional(),
  llm: z.string().trim().min(1).max(100).optional(),
  language: z.string().trim().min(1).max(10).optional(),
  businessName: z.string().trim().max(120).optional(),
  greeting: z.string().trim().max(600).optional(),
  extraInstructions: z.string().max(EXTRA_INSTRUCTIONS_MAX_LENGTH).optional(),
  emailSignature: z.string().max(10000).optional(),
  maxCallMinutes: z.number().int().min(1).max(MAX_CALL_MINUTES_LIMIT).optional(),
  // 0 is off; otherwise within the bounds.
  silenceHangUpSeconds: z.number().int().refine(
    (value) => value === 0 || (value >= SILENCE_HANG_UP_MIN_SECONDS && value <= SILENCE_HANG_UP_MAX_SECONDS),
    `is 0 (off) or between ${SILENCE_HANG_UP_MIN_SECONDS} and ${SILENCE_HANG_UP_MAX_SECONDS} seconds`,
  ).optional(),
  engine: z.enum(ENGINES).optional(),
  openaiApiKey: z.string().trim().min(1).max(500).optional(),
  clearOpenaiApiKey: z.boolean().optional(),
  // Empty clears it; otherwise the shape OpenAI shows under Settings > Project.
  openaiProjectId: z.string().trim().max(100).regex(/^(proj_[A-Za-z0-9]+)?$/, 'starts with proj_ and has only letters and numbers after it').optional(),
  openaiWebhookSecret: z.string().trim().min(1).max(500).regex(/^whsec_[A-Za-z0-9+/=]+$/, 'starts with whsec_').optional(),
  liveVoice: z.string().trim().min(1).max(128).optional(),
  liveBackendModel: z.string().trim().min(1).max(100).optional(),
  liveRegion: z.enum(LIVE_REGIONS).optional(),
  liveTypingSound: z.boolean().optional(),
})

export async function PATCH(request: NextRequest) {
  const { error } = await guard()
  if (error) return error

  const raw = await request.json().catch(() => null)
  if (raw === null || typeof raw !== 'object') return errorResponse('The save request arrived empty or unreadable. Reload the page and try again.')
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    const problems = [...new Set(parsed.error.issues.map(describeIssue))]
    return errorResponse(`Could not save: ${problems.join(' ')}`)
  }

  // Switching the assistant on with nothing behind it would send callers to
  // forwarding anyway, but it would look as though it were working.
  if (parsed.data.enabled === true && !engineReady(await getSettings())) {
    return errorResponse('Set the assistant up first, then switch it on.')
  }

  try {
    await updateSettings(parsed.data)
  } catch (cause) {
    console.error('[ai-call-answering] could not save settings', cause)
    return errorResponse('Could not save those settings. Check that this site has an encryption key set up.', 500)
  }
  return NextResponse.json(await currentState())
}

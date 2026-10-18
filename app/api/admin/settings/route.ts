// GET/PATCH /api/m/ai-call-answering/admin/settings - the module's settings.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSiteUrl } from '@/lib/config/env'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { assistantNeedsSetup, fallbackNeedsSetup, postCallWebhookUrl } from '@/modules/ai-call-answering/lib/agent-sync'
import { MAX_FALLBACK_KEYS, listFallbackKeys } from '@/modules/ai-call-answering/lib/fallback-keys'
import {
  LANGUAGE_CHOICES,
  LLM_CHOICES,
  MAX_CALL_MINUTES_LIMIT,
  TTS_MODEL_CHOICES,
  getSettings,
  updateSettings,
} from '@/modules/ai-call-answering/lib/settings'

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
    agentId: settings.agentId,
    isSetUp: !!settings.agentId,
    needsSetup: assistantNeedsSetup(settings, siteUrl) || fallbacks.some((f) => fallbackNeedsSetup(settings, f, siteUrl)),
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
  }
}

export async function GET() {
  const { error } = await guard()
  if (error) return error
  return NextResponse.json(await currentState(), { headers: { 'Cache-Control': 'no-store' } })
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
  extraInstructions: z.string().max(4000).optional(),
  emailSignature: z.string().max(10000).optional(),
  maxCallMinutes: z.number().int().min(1).max(MAX_CALL_MINUTES_LIMIT).optional(),
})

export async function PATCH(request: NextRequest) {
  const { error } = await guard()
  if (error) return error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those settings did not make sense.')

  // Switching the assistant on with nothing behind it would send callers to
  // forwarding anyway, but it would look as though it were working.
  if (parsed.data.enabled === true && !(await getSettings()).agentId) {
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

import { randomBytes } from 'crypto'
import { getSiteUrl } from '@/lib/config/env'
import {
  ElevenLabsError,
  agentExists,
  createAgent,
  createPostCallWebhook,
  createTool,
  updateAgent,
  updateTool,
} from './elevenlabs'
import { TOOL_NAMES, buildAgentBody, buildToolConfig, configHash, type AgentInputs } from './agent-config'
import { getSettings, saveProvisionedState, saveWebhook, type AiCallSettings } from './settings'

// ---------------------------------------------------------------------------
// "Set up the assistant": make (or bring up to date) everything on the
// ElevenLabs side that this module depends on - the post-call webhook, the five
// tools, and the agent that uses them - and remember the ids.
//
// Safe to run again whenever settings change. Existing pieces are updated in
// place, so an agent id printed on a number's Twilio config never changes.
// ---------------------------------------------------------------------------

/** A problem the person pressing the button can act on, in plain words. */
export class SetupError extends Error {}

export function postCallWebhookUrl(siteUrl: string): string {
  return `${siteUrl}/api/m/ai-call-answering/webhooks/post-call`
}

export function agentInputsFrom(
  settings: AiCallSettings,
  siteUrl: string,
  toolsToken: string,
  toolIds: Record<string, string>,
  postCallWebhookId: string,
): AgentInputs {
  return {
    businessName: settings.businessName,
    siteUrl,
    greeting: settings.greeting,
    extraInstructions: settings.extraInstructions,
    voiceId: settings.voiceId,
    ttsModel: settings.ttsModel,
    llm: settings.llm,
    language: settings.language,
    maxCallMinutes: settings.maxCallMinutes,
    toolsToken,
    toolIds,
    postCallWebhookId,
  }
}

/** Whether what ElevenLabs holds is out of step with the settings here. */
export function assistantNeedsSetup(settings: AiCallSettings, siteUrl: string): boolean {
  if (!settings.agentId || !settings.postCallWebhookId || !settings.toolsToken) return true
  const current = agentInputsFrom(settings, siteUrl, settings.toolsToken, settings.toolIds, settings.postCallWebhookId)
  return configHash(current) !== settings.syncedHash
}

async function upsertTool(apiKey: string, existingId: string | undefined, config: Record<string, unknown>): Promise<string> {
  if (existingId) {
    try {
      await updateTool(apiKey, existingId, config)
      return existingId
    } catch (error) {
      // Deleted over at ElevenLabs: make it again rather than failing.
      if (!(error instanceof ElevenLabsError && error.status === 404)) throw error
    }
  }
  return createTool(apiKey, config)
}

export async function provisionAssistant(): Promise<{ agentId: string; created: boolean }> {
  const settings = await getSettings()
  if (!settings.apiKey) throw new SetupError('Add your ElevenLabs API key first.')
  if (!settings.voiceId) throw new SetupError('Choose a voice first.')
  const apiKey = settings.apiKey
  const siteUrl = getSiteUrl()

  try {
    let webhookId = settings.postCallWebhookId
    let webhookSecret: string | null = null
    if (!webhookId) {
      const webhook = await createPostCallWebhook(apiKey, 'Cactus call answering', postCallWebhookUrl(siteUrl))
      webhookId = webhook.id
      webhookSecret = webhook.secret
      if (!webhookSecret) throw new SetupError('ElevenLabs made the webhook but did not give back its signing secret.')
      await saveWebhook(webhookId, webhookSecret)
    }

    const toolsToken = settings.toolsToken ?? randomBytes(32).toString('hex')
    const toolIds: Record<string, string> = {}
    for (const name of TOOL_NAMES) {
      toolIds[name] = await upsertTool(apiKey, settings.toolIds[name], buildToolConfig(name, siteUrl, toolsToken))
    }

    const inputs = agentInputsFrom(settings, siteUrl, toolsToken, toolIds, webhookId)
    const body = buildAgentBody(inputs)
    let agentId = settings.agentId
    let created = false
    if (agentId && (await agentExists(apiKey, agentId))) {
      await updateAgent(apiKey, agentId, body)
    } else {
      agentId = await createAgent(apiKey, body)
      created = true
    }

    await saveProvisionedState({
      agentId,
      postCallWebhookId: webhookId,
      webhookSecret,
      toolsToken,
      toolIds,
      syncedHash: configHash(inputs),
    })
    return { agentId, created }
  } catch (error) {
    if (error instanceof SetupError) throw error
    if (error instanceof ElevenLabsError) throw new SetupError(error.message)
    throw error
  }
}

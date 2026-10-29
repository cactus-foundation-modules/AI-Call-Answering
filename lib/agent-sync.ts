import { randomBytes } from 'crypto'
import { getSiteUrl } from '@/lib/config/env'
import {
  ElevenLabsError,
  agentExists,
  createAgent,
  createPostCallWebhook,
  createTool,
  postCallWebhookExists,
  addLibraryVoice,
  findLibraryOrigin,
  listVoices,
  updateAgent,
  updateTool,
} from './elevenlabs'
import { TOOL_NAMES, buildAgentBody, buildToolConfig, configHash, onlyCodeChanged, type AgentInputs } from './agent-config'
import { callInProgress } from './calls'
import {
  listFallbackKeys,
  saveFallbackProvisioned,
  saveFallbackWebhook,
  type FallbackKey,
} from './fallback-keys'
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

/** The same question for one fallback key. */
export function fallbackNeedsSetup(settings: AiCallSettings, fallback: FallbackKey, siteUrl: string): boolean {
  if (!fallback.agentId || !fallback.postCallWebhookId || !settings.toolsToken) return true
  const current = agentInputsFrom(settings, siteUrl, settings.toolsToken, fallback.toolIds, fallback.postCallWebhookId)
  return configHash(current) !== fallback.syncedHash
}

/** Whether the hourly job should set the assistant up again unattended: it has
 *  been set up before, and the main key or a fallback is out of date only
 *  because the module itself was updated. A setting somebody changed and has
 *  not pushed yet is theirs to push, so any such change stops it. */
export function autoResyncDue(settings: AiCallSettings, fallbacks: FallbackKey[], siteUrl: string): boolean {
  if (!settings.apiKey || !settings.agentId || !settings.postCallWebhookId || !settings.toolsToken) return false
  const main = agentInputsFrom(settings, siteUrl, settings.toolsToken, settings.toolIds, settings.postCallWebhookId)
  if (configHash(main) !== settings.syncedHash && !onlyCodeChanged(main, settings.syncedHash)) return false
  let due = configHash(main) !== settings.syncedHash
  for (const fallback of fallbacks) {
    if (!fallback.apiKey || !fallback.agentId || !fallback.postCallWebhookId) continue
    const inputs = agentInputsFrom(settings, siteUrl, settings.toolsToken, fallback.toolIds, fallback.postCallWebhookId)
    if (configHash(inputs) === fallback.syncedHash) continue
    if (!onlyCodeChanged(inputs, fallback.syncedHash)) return false
    due = true
  }
  return due
}

export type AutoResyncOutcome =
  | { status: 'up_to_date' | 'waiting_for_owner' | 'call_in_progress' }
  | { status: 'resynced'; fallbackFailures: FallbackFailure[] }

/** The hourly job: brings the ElevenLabs side up to date after a module update,
 *  so a release reaches the phone without anybody pressing "Set up the
 *  assistant". Never while a call is live: the caller keeps the version they
 *  started with, and the next tick catches up. */
export async function autoResync(): Promise<AutoResyncOutcome> {
  const settings = await getSettings()
  const siteUrl = getSiteUrl()
  if (!autoResyncDue(settings, await listFallbackKeys(), siteUrl)) {
    return { status: assistantNeedsSetup(settings, siteUrl) ? 'waiting_for_owner' : 'up_to_date' }
  }
  if (await callInProgress(settings.maxCallMinutes)) return { status: 'call_in_progress' }
  const { fallbackFailures } = await provisionAssistant()
  return { status: 'resynced', fallbackFailures }
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

/** The id to speak with on a second account. A voice is per account: one picked
 *  from the shared library was added to the main account only, so it is added to
 *  this one too, and this account's own copy is used. */
async function voiceForAccount(mainKey: string, accountKey: string, voiceId: string): Promise<string> {
  const there = await listVoices(accountKey)
  if (there.some((voice) => voice.id === voiceId)) return voiceId
  const origin = await findLibraryOrigin(mainKey, voiceId).catch(() => null)
  if (!origin) {
    throw new SetupError('The chosen voice is not on this ElevenLabs account, and it is not a library voice that can be added to it. Pick a library voice, or add the same voice to this account.')
  }
  // Added by an earlier run under another id: use that, rather than a duplicate.
  const earlier = there.find((voice) => voice.name === origin.name)
  if (earlier) return earlier.id
  return addLibraryVoice(accountKey, origin)
}

/** What one ElevenLabs account needs to answer calls, made or brought up to date.
 *  The webhook secret is passed to `keepSecret` the moment it is handed over,
 *  because it is shown once. */
async function provisionAccount(
  apiKey: string,
  settings: AiCallSettings,
  siteUrl: string,
  toolsToken: string,
  existing: { webhookId: string | null; toolIds: Record<string, string>; agentId: string | null },
  keepSecret: (webhookId: string, secret: string) => Promise<void>,
  accountVoiceId: string = settings.voiceId,
): Promise<{ agentId: string; created: boolean; webhookId: string; webhookSecret: string | null; toolIds: Record<string, string>; syncedHash: string }> {
  let webhookId = existing.webhookId
  let webhookSecret: string | null = null
  // The stored ids may be another ElevenLabs account's (the key was swapped):
  // an id this account does not hold is made again rather than failing.
  if (webhookId && !(await postCallWebhookExists(apiKey, webhookId))) webhookId = null
  if (!webhookId) {
    const webhook = await createPostCallWebhook(apiKey, 'Cactus call answering', postCallWebhookUrl(siteUrl))
    webhookId = webhook.id
    webhookSecret = webhook.secret
    if (!webhookSecret) throw new SetupError('ElevenLabs made the webhook but did not give back its signing secret.')
    await keepSecret(webhookId, webhookSecret)
  }

  const toolIds: Record<string, string> = {}
  for (const name of TOOL_NAMES) {
    toolIds[name] = await upsertTool(apiKey, existing.toolIds[name], buildToolConfig(name, siteUrl, toolsToken))
  }

  const inputs = agentInputsFrom(settings, siteUrl, toolsToken, toolIds, webhookId)
  // The hash stays on the chosen voice, so the screen can tell what is out of
  // date; only the agent itself speaks with this account's copy of it.
  const body = buildAgentBody({ ...inputs, voiceId: accountVoiceId })
  let agentId = existing.agentId
  let created = false
  if (agentId && (await agentExists(apiKey, agentId))) {
    await updateAgent(apiKey, agentId, body)
  } else {
    agentId = await createAgent(apiKey, body)
    created = true
  }
  return { agentId, created, webhookId, webhookSecret, toolIds, syncedHash: configHash(inputs) }
}

export type FallbackFailure = { label: string; message: string }

export async function provisionAssistant(): Promise<{ agentId: string; created: boolean; fallbackFailures: FallbackFailure[] }> {
  const settings = await getSettings()
  if (!settings.apiKey) throw new SetupError('Add your ElevenLabs API key first.')
  if (!settings.voiceId) throw new SetupError('Choose a voice first.')
  const apiKey = settings.apiKey
  const siteUrl = getSiteUrl()

  let main
  const toolsToken = settings.toolsToken ?? randomBytes(32).toString('hex')
  try {
    main = await provisionAccount(
      apiKey,
      settings,
      siteUrl,
      toolsToken,
      { webhookId: settings.postCallWebhookId, toolIds: settings.toolIds, agentId: settings.agentId },
      saveWebhook,
    )
    await saveProvisionedState({
      agentId: main.agentId,
      postCallWebhookId: main.webhookId,
      webhookSecret: main.webhookSecret,
      toolsToken,
      toolIds: main.toolIds,
      syncedHash: main.syncedHash,
    })
  } catch (error) {
    if (error instanceof SetupError) throw error
    if (error instanceof ElevenLabsError) throw new SetupError(error.message)
    throw error
  }

  // The fallbacks share the tools token just saved. One failing (a key out of
  // credit, a voice that account does not have) must not undo the main key's
  // setup, so each reports for itself.
  const fallbackFailures: FallbackFailure[] = []
  for (const [index, fallback] of (await listFallbackKeys()).entries()) {
    const label = fallback.label || `Fallback key ${index + 1}`
    if (!fallback.apiKey) {
      fallbackFailures.push({ label, message: 'The saved key cannot be read. Remove it and add it again.' })
      continue
    }
    try {
      const accountVoice = await voiceForAccount(apiKey, fallback.apiKey, settings.voiceId)
      const done = await provisionAccount(
        fallback.apiKey,
        settings,
        siteUrl,
        toolsToken,
        { webhookId: fallback.postCallWebhookId, toolIds: fallback.toolIds, agentId: fallback.agentId },
        (webhookId, secret) => saveFallbackWebhook(fallback.id, webhookId, secret),
        accountVoice,
      )
      await saveFallbackProvisioned(fallback.id, { agentId: done.agentId, toolIds: done.toolIds, syncedHash: done.syncedHash })
    } catch (error) {
      const message = error instanceof SetupError || error instanceof ElevenLabsError ? error.message : 'Setting this key up failed. Check the logs.'
      if (!(error instanceof SetupError || error instanceof ElevenLabsError)) console.error('[ai-call-answering] fallback setup failed', error)
      fallbackFailures.push({ label, message })
    }
  }
  return { agentId: main.agentId, created: main.created, fallbackFailures }
}

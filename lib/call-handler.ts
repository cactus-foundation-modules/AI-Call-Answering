import type { InboundCallContext, InboundCallHandler } from '@/modules/twilio/lib/inbound-call-handlers'
import { openCall } from './calls'
import { escapeXml } from '@/modules/twilio/lib/twilio'
import { getSiteUrl } from '@/lib/config/env'
import { ElevenLabsError, REGISTER_CALL_TIMEOUT_MS, innerTwiml, isOutOfCredit, registerCall } from './elevenlabs'
import { callCandidates, isKeyProblem, knownOutOfCredit, listFallbackKeys, markKeyRefused, orderCandidates } from './fallback-keys'
import { getAssignmentForNumber, shouldAnswer } from './numbers'
import { getSettings } from './settings'

// The assistant's end of the twilio module's `twilio.inbound-call-handler`
// seam: offered every call that reaches the voice webhook, it either connects
// the caller to the ElevenLabs agent or declines.
//
// The rule that governs every line below: a caller must never be left worse off
// for the assistant being installed. Anything that goes wrong - no key, no
// agent, ElevenLabs slow or down, an answer that is not a connection - returns
// null, and the number's ordinary forwarding and voicemail take the call.
//
// SERVER ONLY. It reaches the ElevenLabs key.

/** Twilio abandons a voice webhook after fifteen seconds; every key tried has to
 *  fit inside this, with room left to answer. */
const TOTAL_BUDGET_MS = 11_000
/** Not worth starting another attempt with less than this left. */
const MIN_ATTEMPT_MS = 1_500

/** Where Twilio goes when the assistant's end of the call finishes. It tells a
 *  call that ran its course from one ElevenLabs dropped a moment in. */
export function callEndedPath(): string {
  return '/api/m/ai-call-answering/webhooks/call-ended'
}

/** The connection, followed by a step that runs only once the assistant has let
 *  go. A caller who hangs up never reaches it. */
export function withEndOfCallCheck(twiml: string, keyId: string): string {
  const url = `${getSiteUrl()}${callEndedPath()}?key=${encodeURIComponent(keyId)}`
  return `${twiml}<Redirect method="POST">${escapeXml(url)}</Redirect>`
}

export const aiInboundCallHandler: InboundCallHandler = async (call: InboundCallContext) => {
  const startedAt = Date.now()
  const settings = await getSettings()
  if (!settings.enabled) return null

  // A fallback list that cannot be read must not stop the main key answering.
  const fallbacks = await listFallbackKeys().catch((error: unknown) => {
    console.error('[ai-call-answering] could not read the fallback keys', error)
    return []
  })
  const candidates = orderCandidates(callCandidates(settings, fallbacks))
  if (candidates.length === 0) return null

  const assignment = await getAssignmentForNumber(call.to)
  if (!shouldAnswer(assignment, call)) return null

  for (const candidate of candidates) {
    const remaining = TOTAL_BUDGET_MS - (Date.now() - startedAt)
    if (remaining < MIN_ATTEMPT_MS) break
    // ElevenLabs takes a call for an account with no credit and then drops it.
    if (await knownOutOfCredit(candidate, (key) => isOutOfCredit(key, Math.min(2_000, remaining)))) {
      markKeyRefused(candidate.id)
      console.error(`[ai-call-answering] ${candidate.id === 'main' ? 'main key' : 'fallback key'} is out of credit, skipping it`)
      continue
    }
    try {
      const document = await registerCall(candidate.apiKey, {
        agentId: candidate.agentId,
        // A withheld number has nothing to register; ElevenLabs wants a string.
        fromNumber: call.from || 'anonymous',
        toNumber: call.to,
        dynamicVariables: { call_sid: call.callSid, caller_number: call.from || 'withheld' },
        timeoutMs: Math.min(REGISTER_CALL_TIMEOUT_MS, remaining),
      })
      const twiml = innerTwiml(document)
      if (!twiml) {
        console.error('[ai-call-answering] ElevenLabs answered with something that does not connect a call')
        continue
      }
      // Recorded only once the caller really is being connected, so the log never
      // holds a call the assistant did not take.
      await openCall({ callSid: call.callSid, fromNumber: call.from, toNumber: call.to }).catch((error: unknown) => {
        console.error('[ai-call-answering] could not open the call record', error)
      })
      return withEndOfCallCheck(twiml, candidate.id)
    } catch (error) {
      if (isKeyProblem(error)) markKeyRefused(candidate.id)
      const reason = error instanceof ElevenLabsError ? error.message : error
      console.error(`[ai-call-answering] could not hand the call to the assistant (${candidate.id === 'main' ? 'main key' : 'fallback key'})`, reason)
    }
  }
  console.error('[ai-call-answering] no key could take the call, falling back to forwarding')
  return null
}

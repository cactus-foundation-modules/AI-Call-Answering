import type { InboundCallContext, InboundCallHandler } from '@/modules/twilio/lib/inbound-call-handlers'
import { openCall } from './calls'
import { ElevenLabsError, innerTwiml, registerCall } from './elevenlabs'
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

export const aiInboundCallHandler: InboundCallHandler = async (call: InboundCallContext) => {
  const settings = await getSettings()
  if (!settings.enabled || !settings.agentId || !settings.apiKey) return null

  const assignment = await getAssignmentForNumber(call.to)
  if (!shouldAnswer(assignment, call)) return null

  try {
    const document = await registerCall(settings.apiKey, {
      agentId: settings.agentId,
      // A withheld number has nothing to register; ElevenLabs wants a string.
      fromNumber: call.from || 'anonymous',
      toNumber: call.to,
      dynamicVariables: { call_sid: call.callSid, caller_number: call.from || 'withheld' },
    })
    const twiml = innerTwiml(document)
    if (!twiml) {
      console.error('[ai-call-answering] ElevenLabs answered with something that does not connect a call')
      return null
    }
    // Recorded only once the caller really is being connected, so the log never
    // holds a call the assistant did not take.
    await openCall({ callSid: call.callSid, fromNumber: call.from, toNumber: call.to }).catch((error: unknown) => {
      console.error('[ai-call-answering] could not open the call record', error)
    })
    return twiml
  } catch (error) {
    const reason = error instanceof ElevenLabsError ? error.message : error
    console.error('[ai-call-answering] could not hand the call to the assistant, falling back', reason)
    return null
  }
}

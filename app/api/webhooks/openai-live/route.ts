// POST /api/m/ai-call-answering/webhooks/openai-live - OpenAI tells the site a
// GPT-Live call has arrived at the project's SIP address. Signature-checked;
// there is no session, OpenAI is the caller.
//
// The call must be one this site put through a moment ago (the call reference
// Twilio passed along, signed, names an open GPT-Live call). It is then
// accepted with the assistant's instructions and tools, and the sideband that
// runs the tools is started after the reply, for as long as the call lasts.
import { NextRequest, NextResponse, after } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { claimLiveCall } from '@/modules/ai-call-answering/lib/calls'
import {
  CALL_HEADER,
  CALL_SIGNATURE_HEADER,
  buildAcceptBody,
  callSignatureMatches,
  liveGreetingInstruction,
  sipHeader,
} from '@/modules/ai-call-answering/lib/live-config'
import { runLiveCall } from '@/modules/ai-call-answering/lib/live-runner'
import { OpenAiError, acceptCall, parseIncomingCall, rejectCall, verifyOpenAiWebhook } from '@/modules/ai-call-answering/lib/openai-live'
import { getSettings, liveReady } from '@/modules/ai-call-answering/lib/settings'

export async function POST(request: NextRequest) {
  // The raw text, not request.json(): the signature is over the exact bytes sent.
  const rawBody = await request.text()
  const settings = await getSettings()
  const signed = verifyOpenAiWebhook(rawBody, {
    id: request.headers.get('webhook-id'),
    timestamp: request.headers.get('webhook-timestamp'),
    signature: request.headers.get('webhook-signature'),
  }, settings.openaiWebhookSecret)
  if (!signed) return new NextResponse('Invalid signature', { status: 401 })

  const incoming = parseIncomingCall(rawBody)
  // Some other event from the same project: acknowledged so it is not retried.
  if (!incoming) return NextResponse.json({ ok: true, ignored: true })
  if (!liveReady(settings) || !settings.openaiApiKey || !settings.openaiWebhookSecret) {
    return NextResponse.json({ ok: true, ignored: true })
  }
  const apiKey = settings.openaiApiKey

  const decline = async (why: string) => {
    console.error(`[ai-call-answering] turning away GPT-Live session ${incoming.sessionId}: ${why}`)
    await rejectCall(apiKey, incoming.sessionId).catch((error: unknown) => {
      // decision_already_made: a retried webhook, already dealt with.
      if (!(error instanceof OpenAiError && error.code === 'decision_already_made')) {
        console.error('[ai-call-answering] could not turn the call away', error)
      }
    })
    return NextResponse.json({ ok: true, rejected: true })
  }

  const callSid = sipHeader(incoming.sipHeaders, CALL_HEADER)
  const signature = sipHeader(incoming.sipHeaders, CALL_SIGNATURE_HEADER)
  if (!callSid || !signature || !callSignatureMatches(callSid, signature, settings.openaiWebhookSecret)) {
    return decline('no valid call reference')
  }
  const call = await claimLiveCall(callSid, incoming.sessionId)
  if (!call) return decline('not an open call of this site, or already taken')

  const inputs = {
    businessName: settings.businessName,
    siteUrl: getSiteUrl(),
    greeting: settings.greeting,
    extraInstructions: settings.extraInstructions,
    language: settings.language,
    voice: settings.liveVoice,
    backendModel: settings.liveBackendModel,
  }
  try {
    await acceptCall(apiKey, incoming.sessionId, buildAcceptBody(inputs))
  } catch (error) {
    if (error instanceof OpenAiError && error.code === 'decision_already_made') {
      return NextResponse.json({ ok: true, duplicate: true })
    }
    // Twilio sees the call fail within a second or two and the call-ended
    // check sends the caller to voicemail.
    console.error('[ai-call-answering] could not accept a GPT-Live call', error)
    return NextResponse.json({ ok: true, accepted: false })
  }

  after(() => runLiveCall({
    apiKey,
    sessionId: incoming.sessionId,
    call,
    greeting: liveGreetingInstruction(inputs),
    backendModel: settings.liveBackendModel,
    maxCallMinutes: settings.maxCallMinutes,
  }))
  return NextResponse.json({ ok: true, accepted: true })
}

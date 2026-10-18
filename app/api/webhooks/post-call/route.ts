// POST /api/m/ai-call-answering/webhooks/post-call - ElevenLabs delivers the
// transcript and analysis of a finished call here. Signature-checked; there is
// no session, ElevenLabs is the caller.
import { NextRequest, NextResponse, after } from 'next/server'
import { announceConversationArrived } from '@/lib/conversations/arrived'
import { getSettings } from '@/modules/ai-call-answering/lib/settings'
import { ingestPostCall, parsePostCallPayload, verifySignature } from '@/modules/ai-call-answering/lib/post-call'

export async function POST(request: NextRequest) {
  // The raw text, not request.json(): the signature is over the exact bytes sent.
  const rawBody = await request.text()
  const settings = await getSettings()
  if (!verifySignature(rawBody, request.headers.get('elevenlabs-signature'), settings.webhookSecret)) {
    return new NextResponse('Invalid signature', { status: 401 })
  }

  const payload = parsePostCallPayload(rawBody)
  if (!payload) return new NextResponse('Unreadable payload', { status: 400 })

  try {
    const outcome = await ingestPostCall(payload)
    if (outcome.status === 'filed') {
      after(() => announceConversationArrived({
        moduleName: 'ai-call-answering',
        providerId: 'ai-call-answering',
        conversationId: outcome.callId,
      }))
    }
    return NextResponse.json({ ok: true, ...outcome })
  } catch (error) {
    // 500 so ElevenLabs retries: a call that is not filed is a call nobody sees.
    console.error('[ai-call-answering] could not file a finished call', error)
    return new NextResponse('Could not file the call', { status: 500 })
  }
}

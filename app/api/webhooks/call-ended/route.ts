// POST /api/m/ai-call-answering/webhooks/call-ended - Twilio comes here when the
// assistant's end of a call finishes (the connection is followed by a redirect
// to this route). A call that ran its course just ends. A call ElevenLabs
// dropped within seconds of connecting - an account out of credit does this -
// goes to the number's voicemail instead, so the caller is never left with a
// dead line. Signature-checked; no session, Twilio is the caller.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { prisma } from '@/lib/db/prisma'
import { validateTwilioSignature, isTwilioConfigured } from '@/modules/twilio/lib/twilio'
import { getRuleForNumber, isRuleOpenNow } from '@/modules/twilio/lib/forwarding'
import { resolveNumberRegion } from '@/modules/twilio/lib/numbers'
import { voiceForRegion } from '@/modules/twilio/lib/voices'
import { voicemailTwiml } from '@/modules/twilio/lib/voicemail'
import { callEndedPath } from '@/modules/ai-call-answering/lib/call-handler'
import { markKeyRefused } from '@/modules/ai-call-answering/lib/fallback-keys'

/** A conversation shorter than this never got going. */
const DROPPED_WITHIN_SECONDS = 10

function twiml(inner: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    headers: { 'Content-Type': 'text/xml' },
  })
}

export async function POST(request: NextRequest) {
  if (!isTwilioConfigured()) return new NextResponse('Not configured', { status: 503 })

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }
  const signature = request.headers.get('x-twilio-signature') ?? ''
  const url = `${getSiteUrl()}${callEndedPath()}${request.nextUrl.search}`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  try {
    const rows = await prisma.$queryRaw<Array<{ seconds: number | string }>>`
      SELECT EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - "started_at")) AS seconds
      FROM "acall_calls" WHERE "call_sid" = ${params.CallSid ?? ''} LIMIT 1
    `
    const seconds = rows[0] ? Number(rows[0].seconds) : null
    if (seconds === null || seconds >= DROPPED_WITHIN_SECONDS) return twiml('<Hangup/>')

    const keyId = request.nextUrl.searchParams.get('key')
    if (keyId) markKeyRefused(keyId)
    console.error(`[ai-call-answering] the assistant dropped call ${params.CallSid} after ${Math.round(seconds)}s, sending the caller to voicemail`)

    const called = params.To ?? ''
    const rule = called ? await getRuleForNumber(called) : null
    if (!rule?.voicemailEnabled) return twiml('<Hangup/>')
    const open = await isRuleOpenNow(rule)
    rule.voicemailVoice = voiceForRegion(rule.voicemailVoice, await resolveNumberRegion(called))
    return twiml(voicemailTwiml(rule, !open))
  } catch (error) {
    console.error('[ai-call-answering] could not check how the call ended', error)
    return twiml('<Hangup/>')
  }
}

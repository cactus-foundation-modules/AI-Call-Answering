// POST /api/m/ai-call-answering/webhooks/live-leg - Twilio comes here when
// OpenAI's leg of a conferenced GPT-Live call ends (the typing sound setting;
// lib/live-conference.ts). Signature-checked; no session, Twilio is the caller.
//
// A leg that connected and then ended has already ended the conference, and the
// caller's own dial has moved on to the end-of-call check. A leg that never
// connected (OpenAI turned the call away, or did not answer) would leave the
// caller alone in a silent conference, so they are moved on to that same check
// here, flagged so that it goes to the number's voicemail however long OpenAI
// took to say no.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { isTwilioConfigured, isTwilioRegion, validateTwilioSignature } from '@/modules/twilio/lib/twilio'
import { callEndedPath } from '@/modules/ai-call-answering/lib/call-handler'
import { legNeverConnected, liveLegPath, redirectCall } from '@/modules/ai-call-answering/lib/live-conference'

export async function POST(request: NextRequest) {
  if (!isTwilioConfigured()) return new NextResponse('Not configured', { status: 503 })

  const form = await request.formData()
  const params: Record<string, string> = {}
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') params[key] = value
  }
  const signature = request.headers.get('x-twilio-signature') ?? ''
  const url = `${getSiteUrl()}${liveLegPath()}${request.nextUrl.search}`
  if (!signature || !validateTwilioSignature(url, params, signature)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  const caller = request.nextUrl.searchParams.get('caller') ?? ''
  const region = request.nextUrl.searchParams.get('region') ?? ''
  const status = params.CallStatus ?? ''
  if (!legNeverConnected(status) || !/^CA[0-9a-fA-F]{32}$/.test(caller) || !isTwilioRegion(region)) {
    return new NextResponse(null, { status: 204 })
  }

  console.error(`[ai-call-answering] GPT-Live did not take conferenced call ${caller} (${status}), moving the caller on`)
  try {
    await redirectCall(region, caller, `${getSiteUrl()}${callEndedPath()}?dropped=1`)
  } catch (error) {
    // The caller hung up already, most likely. Nothing left to rescue.
    console.error('[ai-call-answering] could not move the caller on from an empty conference', error)
  }
  return new NextResponse(null, { status: 204 })
}

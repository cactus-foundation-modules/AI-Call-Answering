// GET /api/m/ai-call-answering/webhooks/typing-sound - the TwiML the typing
// sound's leg runs (lib/live-conference.ts): the keyboard loop, played until
// the leg is removed. Public, as Twilio fetches it: it says nothing about any
// call and plays the same file to everyone.
import { NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { typingAudioPath, typingTwiml } from '@/modules/ai-call-answering/lib/live-conference'

export function GET() {
  return new NextResponse(typingTwiml(`${getSiteUrl()}${typingAudioPath()}`), {
    headers: { 'Content-Type': 'text/xml', 'Cache-Control': 'no-store' },
  })
}

export const POST = GET

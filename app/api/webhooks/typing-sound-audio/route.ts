// GET /api/m/ai-call-answering/webhooks/typing-sound-audio - the keyboard loop
// itself, a small WAV made by lib/typing-sound.ts. Public and the same for
// everyone, so Twilio may cache it.
import { NextResponse } from 'next/server'
import { typingSoundWav } from '@/modules/ai-call-answering/lib/typing-sound'

export function GET() {
  return new NextResponse(new Uint8Array(typingSoundWav()), {
    headers: { 'Content-Type': 'audio/wav', 'Cache-Control': 'public, max-age=86400' },
  })
}

// GET /api/m/ai-call-answering/admin/live-voice-preview?voice=<id> - a short
// spoken sample of a GPT-Live voice, as a WAV, for the voice picker. Made by
// GPT-Live itself (lib/live-voice-preview.ts) with the shop's own name, then
// kept in memory, so a second play costs nothing.
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { VoicePreviewError, getVoicePreview, previewLine } from '@/modules/ai-call-answering/lib/live-voice-preview'
import { getSettings } from '@/modules/ai-call-answering/lib/settings'

// A built-in name or a custom voice id: letters, digits, dashes and
// underscores, as long as OpenAI allows a voice id to be.
const Query = z.object({ voice: z.string().trim().regex(/^[A-Za-z0-9_-]{1,128}$/) })

export async function GET(request: NextRequest) {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return errorResponse('Forbidden', 403)

  const query = Query.safeParse({ voice: request.nextUrl.searchParams.get('voice') ?? '' })
  if (!query.success) return errorResponse('That voice name could not be read.', 400)
  const settings = await getSettings()
  if (!settings.openaiApiKey) return errorResponse('Add your OpenAI API key and save first.', 400)

  try {
    const wav = await getVoicePreview(settings.openaiApiKey, query.data.voice, previewLine(settings.businessName))
    return new NextResponse(new Uint8Array(wav), {
      headers: {
        'Content-Type': 'audio/wav',
        'Content-Length': String(wav.length),
        // The browser keeps it for the visit; nobody else should.
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch (error) {
    const message = error instanceof VoicePreviewError ? error.message : 'Could not make a sample of that voice.'
    if (!(error instanceof VoicePreviewError)) console.error('[ai-call-answering] voice preview failed', error)
    return errorResponse(message, 502)
  }
}

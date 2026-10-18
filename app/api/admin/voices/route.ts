// GET /api/m/ai-call-answering/admin/voices - the voices on the ElevenLabs account.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { ElevenLabsError, listVoices } from '@/modules/ai-call-answering/lib/elevenlabs'
import { getSettings } from '@/modules/ai-call-answering/lib/settings'

export async function GET() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return errorResponse('Forbidden', 403)

  const { apiKey } = await getSettings()
  if (!apiKey) return NextResponse.json({ voices: [], note: 'Add your ElevenLabs API key to see its voices.' })
  try {
    return NextResponse.json({ voices: await listVoices(apiKey), note: null })
  } catch (error) {
    // A soft failure: the voice box still takes an id typed in by hand.
    const note = error instanceof ElevenLabsError ? error.message : 'Could not load the voices.'
    return NextResponse.json({ voices: [], note })
  }
}

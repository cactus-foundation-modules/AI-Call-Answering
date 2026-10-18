// GET  /api/m/ai-call-answering/admin/voices - the voices on the ElevenLabs account,
//        or with ?source=library the shared Voice Library, filtered.
// POST /api/m/ai-call-answering/admin/voices - add a library voice to the account.
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { addLibraryVoice, ElevenLabsError, listVoices, searchVoiceLibrary } from '@/modules/ai-call-answering/lib/elevenlabs'
import { getSettings } from '@/modules/ai-call-answering/lib/settings'

const LibraryQuery = z.object({
  search: z.string().trim().max(100).default(''),
  accent: z.string().trim().max(40).default(''),
  gender: z.string().trim().max(20).default(''),
  age: z.string().trim().max(20).default(''),
  page: z.coerce.number().int().min(0).max(200).default(0),
})

const AddBody = z.object({
  publicOwnerId: z.string().trim().min(1).max(100),
  voiceId: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(100),
})

async function authorise() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return errorResponse('Forbidden', 403)
  return null
}

export async function GET(request: NextRequest) {
  const denied = await authorise()
  if (denied) return denied

  const { apiKey } = await getSettings()
  if (!apiKey) return NextResponse.json({ voices: [], hasMore: false, note: 'Add your ElevenLabs API key to see its voices.' })
  try {
    const params = request.nextUrl.searchParams
    if (params.get('source') === 'library') {
      const filters = LibraryQuery.parse(Object.fromEntries(params))
      const found = await searchVoiceLibrary(apiKey, filters)
      return NextResponse.json({ ...found, note: null })
    }
    return NextResponse.json({ voices: await listVoices(apiKey), hasMore: false, note: null })
  } catch (error) {
    // A soft failure: the voice box still takes an id typed in by hand.
    const note = error instanceof ElevenLabsError ? error.message : 'Could not load the voices.'
    return NextResponse.json({ voices: [], hasMore: false, note })
  }
}

export async function POST(request: NextRequest) {
  const denied = await authorise()
  if (denied) return denied

  const body = AddBody.safeParse(await request.json().catch(() => null))
  if (!body.success) return errorResponse('That voice could not be read. Try choosing it again.', 400)
  const { apiKey } = await getSettings()
  if (!apiKey) return errorResponse('Add your ElevenLabs API key first.', 400)
  try {
    const id = await addLibraryVoice(apiKey, body.data)
    return NextResponse.json({ id })
  } catch (error) {
    return errorResponse(error instanceof ElevenLabsError ? error.message : 'Could not add that voice.', 502)
  }
}

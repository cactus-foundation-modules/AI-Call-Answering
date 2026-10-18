// POST/DELETE /api/m/ai-call-answering/admin/fallback-keys - extra ElevenLabs
// keys the assistant tries when the main one cannot take a call (usually
// because its credit has run out). Each is made ready by "Set up the assistant".
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { MAX_FALLBACK_KEYS, addFallbackKey, removeFallbackKey } from '@/modules/ai-call-answering/lib/fallback-keys'

async function allowed(): Promise<Response | null> {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return errorResponse('Forbidden', 403)
  return null
}

const AddBody = z.object({
  label: z.string().trim().max(60).default(''),
  apiKey: z.string().trim().min(1).max(500),
})

export async function POST(request: NextRequest) {
  const denied = await allowed()
  if (denied) return denied
  const parsed = AddBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Paste the fallback key to add.')
  try {
    if (!(await addFallbackKey(parsed.data.label, parsed.data.apiKey))) {
      return errorResponse(`You can have up to ${MAX_FALLBACK_KEYS} fallback keys. Remove one first.`)
    }
  } catch (cause) {
    console.error('[ai-call-answering] could not save a fallback key', cause)
    return errorResponse('Could not save that key. Check that this site has an encryption key set up.', 500)
  }
  return NextResponse.json({ ok: true })
}

const RemoveBody = z.object({ id: z.string().trim().min(1).max(100) })

export async function DELETE(request: NextRequest) {
  const denied = await allowed()
  if (denied) return denied
  const parsed = RemoveBody.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Which key?')
  await removeFallbackKey(parsed.data.id)
  return NextResponse.json({ ok: true })
}

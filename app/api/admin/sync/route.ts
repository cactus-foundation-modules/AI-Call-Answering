// POST /api/m/ai-call-answering/admin/sync - "Set up the assistant": creates or
// updates the ElevenLabs agent, its tools and its post-call webhook.
import { NextResponse } from 'next/server'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { SetupError, provisionAssistant } from '@/modules/ai-call-answering/lib/agent-sync'

export async function POST() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return errorResponse('Forbidden', 403)

  try {
    const { agentId, created } = await provisionAssistant()
    return NextResponse.json({ ok: true, agentId, created })
  } catch (error) {
    if (error instanceof SetupError) return errorResponse(error.message, 400)
    console.error('[ai-call-answering] setup failed', error)
    return errorResponse('Setting the assistant up failed. Check the logs for details.', 500)
  }
}

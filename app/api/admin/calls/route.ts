// GET/PATCH /api/m/ai-call-answering/admin/calls - the calls the assistant took.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { buildOverview, buildTranscriptText } from '@/modules/ai-call-answering/lib/call-overview'
import { getCall, listRecentCalls, markRead, setHandled } from '@/modules/ai-call-answering/lib/calls'

const LIST_LIMIT = 50

async function guard() {
  const user = await getSessionFromCookie()
  if (!user) return { error: errorResponse('Not authenticated', 401) }
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return { error: errorResponse('Forbidden', 403) }
  return { user }
}

export async function GET() {
  const { error } = await guard()
  if (error) return error
  const calls = await listRecentCalls(LIST_LIMIT)
  return NextResponse.json({
    calls: calls.map((call) => ({
      id: call.id,
      fromNumber: call.fromNumber,
      status: call.status,
      startedAt: call.startedAt.toISOString(),
      durationSeconds: call.durationSeconds,
      callbackNeeded: call.callbackNeeded,
      handled: call.handledAt !== null,
      callerName: call.callerName,
      callerEmail: call.callerEmail,
      overview: buildOverview(call),
      transcript: buildTranscriptText(call),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({
  id: z.string().trim().min(1).max(64),
  handled: z.boolean().optional(),
  read: z.boolean().optional(),
})

export async function PATCH(request: NextRequest) {
  const { error } = await guard()
  if (error) return error
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('That did not make sense.')
  if (!(await getCall(parsed.data.id))) return errorResponse('That call could not be found.', 404)

  if (parsed.data.handled !== undefined) await setHandled(parsed.data.id, parsed.data.handled)
  if (parsed.data.read) await markRead(parsed.data.id)
  return NextResponse.json({ ok: true })
}

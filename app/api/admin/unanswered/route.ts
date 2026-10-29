// GET/PATCH /api/m/ai-call-answering/admin/unanswered - the questions the
// assistant could not answer, and ticking one off once it has been dealt with
// (an FAQ written, a page updated).
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { listUnanswered, setUnansweredResolved } from '@/modules/ai-call-answering/lib/unanswered'

async function guard() {
  const user = await getSessionFromCookie()
  if (!user) return errorResponse('Not authenticated', 401)
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return errorResponse('Forbidden', 403)
  return null
}

export async function GET(request: NextRequest) {
  const denied = await guard()
  if (denied) return denied
  const days = Number(new URL(request.url).searchParams.get('days') ?? 7)
  const items = await listUnanswered(Number.isFinite(days) ? days : 7)
  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({ id: z.string().min(1).max(100), resolved: z.boolean() })

export async function PATCH(request: NextRequest) {
  const denied = await guard()
  if (denied) return denied
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Bad request', 400)
  await setUnansweredResolved(parsed.data.id, parsed.data.resolved)
  return NextResponse.json({ ok: true })
}

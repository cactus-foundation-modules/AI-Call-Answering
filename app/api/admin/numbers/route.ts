// GET/PUT /api/m/ai-call-answering/admin/numbers - which Twilio numbers the
// assistant answers.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSessionFromCookie } from '@/lib/auth/session'
import { hasPermission } from '@/lib/permissions/check'
import { errorResponse } from '@/lib/utils'
import { getRuleForNumber } from '@/modules/twilio/lib/forwarding'
import { getSiteNumbers } from '@/modules/twilio/lib/numbers'
import { ANSWER_MODES, listAssignments, saveAssignment } from '@/modules/ai-call-answering/lib/numbers'

async function guard() {
  const user = await getSessionFromCookie()
  if (!user) return { error: errorResponse('Not authenticated', 401) }
  if (!(await hasPermission(user, 'ai-call-answering.manage'))) return { error: errorResponse('Forbidden', 403) }
  return { user }
}

async function currentState() {
  const [siteNumbers, assignments] = await Promise.all([getSiteNumbers(), listAssignments()])
  const bySid = new Map(assignments.map((assignment) => [assignment.phoneSid, assignment]))
  const numbers = await Promise.all(siteNumbers.map(async (number) => {
    const assignment = bySid.get(number.phoneSid)
    const rule = await getRuleForNumber(number.phoneNumber)
    return {
      phoneSid: number.phoneSid,
      phoneNumber: number.phoneNumber,
      friendlyName: number.friendlyName,
      enabled: assignment?.enabled ?? false,
      mode: assignment?.mode ?? 'always',
      // The assistant is only offered a call that reaches the twilio module's
      // voice webhook, and that webhook is only pointed at a number which has
      // forwarding or voicemail switched on.
      reachable: !!rule && (rule.enabled || rule.voicemailEnabled),
    }
  }))
  return { numbers }
}

export async function GET() {
  const { error } = await guard()
  if (error) return error
  return NextResponse.json(await currentState(), { headers: { 'Cache-Control': 'no-store' } })
}

const Body = z.object({
  phoneSid: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
  mode: z.enum(ANSWER_MODES),
})

export async function PUT(request: NextRequest) {
  const { error } = await guard()
  if (error) return error
  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return errorResponse('Those settings did not make sense.')

  // Only numbers the twilio module already has can be given to the assistant.
  const number = (await getSiteNumbers()).find((candidate) => candidate.phoneSid === parsed.data.phoneSid)
  if (!number) return errorResponse('That number has not been added in the Twilio settings.')

  await saveAssignment({ phoneSid: number.phoneSid, phoneNumber: number.phoneNumber, enabled: parsed.data.enabled, mode: parsed.data.mode })
  return NextResponse.json(await currentState())
}

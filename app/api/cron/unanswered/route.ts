// GET/POST /api/m/ai-call-answering/cron/unanswered
//
// Monday morning: a notification saying how many caller questions the
// assistant could not answer last week, linking to the list. Same CRON_SECRET
// bearer as every other module's cron.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { announceWeeklyUnanswered } from '@/modules/ai-call-answering/lib/unanswered'

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)
  try {
    return NextResponse.json({ ok: true, unanswered: await announceWeeklyUnanswered() })
  } catch (error) {
    console.error('[ai-call-answering] weekly unanswered notice failed', error)
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : 'failed' }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}

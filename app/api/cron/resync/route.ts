// GET/POST /api/m/ai-call-answering/cron/resync
//
// Hourly cron: when the module has been updated since the assistant was last
// set up, and nobody has changed a setting in between, pushes the new wording
// and tools to ElevenLabs. Without it a release reaches the phone only once
// somebody notices the "changed since set up" note and presses the button,
// which on one site left callers on week-old instructions. Same CRON_SECRET
// bearer as every other module's cron.
import { NextRequest, NextResponse } from 'next/server'
import { errorResponse } from '@/lib/utils'
import { SetupError, autoResync } from '@/modules/ai-call-answering/lib/agent-sync'

async function handle(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return errorResponse('CRON_SECRET is not configured', 503)
  if (request.headers.get('authorization') !== `Bearer ${secret}`) return errorResponse('Unauthorized', 401)

  try {
    const outcome = await autoResync()
    if (outcome.status === 'resynced' && outcome.fallbackFailures.length > 0) {
      console.error('[ai-call-answering] automatic setup left fallback keys behind', outcome.fallbackFailures)
    }
    return NextResponse.json({ ok: true, ...outcome })
  } catch (error) {
    const message = error instanceof SetupError || error instanceof Error ? error.message : 'automatic setup failed'
    console.error('[ai-call-answering] automatic setup failed', error)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}

export async function GET(request: NextRequest) {
  return handle(request)
}

export async function POST(request: NextRequest) {
  return handle(request)
}

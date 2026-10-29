// POST /api/m/ai-call-answering/tools/<tool> - the assistant's tools, called by
// ElevenLabs in the middle of a call. Authenticated by the bearer token the
// module put on each tool when it set the assistant up.
import { NextRequest, NextResponse, after } from 'next/server'
import { announceConversationArrived } from '@/lib/conversations/arrived'
import { isToolName } from '@/modules/ai-call-answering/lib/agent-config'
import { getSettings } from '@/modules/ai-call-answering/lib/settings'
import { announceCallback, runTool } from '@/modules/ai-call-answering/lib/tool-handlers'
import { bearerToken, tokensMatch } from '@/modules/ai-call-answering/lib/tool-auth'
import { recordToolCall, toolLogEntry } from '@/modules/ai-call-answering/lib/tool-log'

type RouteContext = { params: Promise<{ tool: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const { tool } = await context.params
  if (!isToolName(tool)) return NextResponse.json({ ok: false, message: 'Unknown tool.' }, { status: 404 })

  const settings = await getSettings()
  if (!tokensMatch(bearerToken(request.headers.get('authorization')), settings.toolsToken)) {
    return NextResponse.json({ ok: false, message: 'Not authorised.' }, { status: 401 })
  }

  const body: unknown = await request.json().catch(() => null)
  const startedAt = Date.now()
  // Written after the reply, so a slow or failed write never holds the caller up.
  const log = (result: Record<string, unknown>, failed: boolean) => {
    const ms = Date.now() - startedAt
    after(async () => {
      await recordToolCall(callIdsOf(body), toolLogEntry({ tool, body, result, ms, failed })).catch((error: unknown) => {
        console.error('[ai-call-answering] could not log a tool call', error)
      })
    })
  }
  try {
    const { result, callbackSaved } = await runTool(tool, body)
    log(result, false)
    if (callbackSaved) {
      after(async () => {
        await announceCallback(callbackSaved)
        await announceConversationArrived({
          moduleName: 'ai-call-answering',
          providerId: 'ai-call-answering',
          conversationId: callbackSaved.id,
        })
      })
    }
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error(`[ai-call-answering] tool ${tool} failed`, error)
    // Still a 200: a failed tool must reach the model as words it can act on.
    const result = {
      ok: false,
      message: 'That did not work just now. Apologise briefly and offer to take a message for a callback.',
    }
    log(result, true)
    return NextResponse.json(result)
  }
}

function callIdsOf(body: unknown): { callSid: string | null; conversationId: string | null } {
  const fields = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const text = (value: unknown) => (typeof value === 'string' && value.trim() && value !== 'unknown' ? value.trim() : null)
  return { callSid: text(fields.call_sid), conversationId: text(fields.conversation_id) }
}

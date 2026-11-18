import { announceConversationArrived } from '@/lib/conversations/arrived'
import { buildTranscriptText } from './call-overview'
import { completeCall, getCall, recordUsage, type CallRecord } from './calls'
import { isToolName } from './agent-config'
import { attachUrl, hangUpCall, summariseCall } from './openai-live'
import { fallbackSummary } from './post-call'
import { addTypingLeg, findConference, regionForNumber, removeLeg, typingApp } from './live-conference'
import { LiveSession, wrapUpInstruction } from './live-session'
import { TypingPlayer } from './typing-player'
import type { TwilioRegion } from '@/modules/twilio/lib/twilio'
import { announceCallback, runTool } from './tool-handlers'
import { recordToolCall, toolLogEntry } from './tool-log'
import { fileTranscriptGaps } from './unanswered'

// ---------------------------------------------------------------------------
// Runs a GPT-Live call from this site's side: opens the sideband socket to the
// accepted session, feeds its events to LiveSession, runs the tools, keeps to
// the call length limit, and files the call when it ends.
//
// It lives as long as the call does, so it needs a server that stays up: a
// long-running Node process (how Cactus sites are hosted) is fine; a serverless
// function that is stopped after its response would cut the call's tools off.
//
// SERVER ONLY. It holds the OpenAI key.
// ---------------------------------------------------------------------------

const LOG = '[ai-call-answering]'

/** Node's built-in WebSocket takes headers as a second argument; the DOM type
 *  this project compiles against does not know that. */
type NodeWebSocketConstructor = new (url: string, init: { headers: Record<string, string> }) => WebSocket

/** Sessions this process is running, so a repeated webhook cannot start a
 *  second runner for the same call. */
const running = new Set<string>()

export type LiveRunInput = {
  apiKey: string
  sessionId: string
  call: CallRecord
  greeting: string
  backendModel: string
  maxCallMinutes: number
  /** The site has the typing sound on, so the call should be in a conference. */
  typingSound: boolean
}

/** Runs one tool as the ElevenLabs route does: same handlers, same log, same
 *  callback alert. The call's ids are added here; the model never supplies
 *  them. */
async function runLoggedTool(call: CallRecord, sessionId: string, name: string, args: Record<string, unknown>): Promise<string> {
  if (!isToolName(name)) return JSON.stringify({ ok: false, message: 'There is no such lookup.' })
  const body = { ...args, call_sid: call.callSid, conversation_id: sessionId }
  const startedAt = Date.now()
  let result: Record<string, unknown>
  let failed = false
  try {
    const outcome = await runTool(name, body)
    result = outcome.result
    if (outcome.callbackSaved) {
      const saved = outcome.callbackSaved
      void (async () => {
        await announceCallback(saved)
        await announceConversationArrived({ moduleName: 'ai-call-answering', providerId: 'ai-call-answering', conversationId: saved.id })
      })().catch((error: unknown) => console.error(`${LOG} could not announce a callback`, error))
    }
  } catch (error) {
    console.error(`${LOG} tool ${name} failed`, error)
    failed = true
    result = { ok: false, message: 'That did not work just now. Apologise briefly and offer to take a message for a callback.' }
  }
  await recordToolCall(
    { callSid: call.callSid, conversationId: sessionId },
    toolLogEntry({ tool: name, body, result, ms: Date.now() - startedAt, failed }),
  ).catch((error: unknown) => console.error(`${LOG} could not log a tool call`, error))
  return JSON.stringify(result)
}

/** The typing sound for one call. Where the call's conference is (its Twilio
 *  region and id) is looked up as the call starts, so the first lookup does not
 *  wait on it. The conference may not count as running for a moment after
 *  OpenAI answers, so a miss is asked again at the next lookup; only a find is
 *  kept. A call that is not in a conference simply gets no typing. */
function typingFor(call: CallRecord): TypingPlayer {
  const log = (message: string, detail?: unknown) => console.error(`${LOG} ${message}`, detail ?? '')
  type Place = { region: TwilioRegion; conferenceSid: string }
  let found: Place | null = null
  let looking: Promise<Place | null> | null = null
  const place = (): Promise<Place | null> => {
    if (found) return Promise.resolve(found)
    looking ??= (async (): Promise<Place | null> => {
      const region = await regionForNumber(call.toNumber)
      // Made or found now, so the first lookup does not wait for it either.
      void typingApp(region).catch((error: unknown) => log('could not set up the typing sound app', error))
      const conferenceSid = await findConference(region, call.callSid)
      if (!conferenceSid) return null
      found = { region, conferenceSid }
      return found
    })().catch((error: unknown) => {
      log('could not find the call\'s conference', error)
      return null
    }).finally(() => { looking = null })
    return looking
  }
  void place()
  return new TypingPlayer({
    start: async () => {
      const at = await place()
      if (!at) throw new Error(`GPT-Live call ${call.callSid} is not in a running conference`)
      return addTypingLeg(at.region, at.conferenceSid, call.callSid, call.toNumber)
    },
    stop: async (leg) => {
      if (found) await removeLeg(found.region, leg)
    },
    log,
  })
}

/** Writes the finished call up: transcript, length, overview, usage, and the
 *  questions it could not answer. */
async function fileCall(input: LiveRunInput, session: LiveSession, startedAt: number): Promise<void> {
  const transcript = session.transcript.result()
  const seconds = session.usage.seconds || Math.round((Date.now() - startedAt) / 1000)
  const current = await getCall(input.call.id)
  const forSummary = current ? { ...current, transcript } : null
  const summary = transcript.length > 0 && forSummary
    ? await summariseCall(input.apiKey, input.backendModel, buildTranscriptText(forSummary))
    : null
  await completeCall(input.call.id, {
    conversationId: input.sessionId,
    durationSeconds: seconds,
    summary: summary ?? fallbackSummary(transcript),
    transcript,
    startedAt: null,
  })
  await recordUsage(input.call.id, { ...session.usage, seconds })
  await fileTranscriptGaps(input.call.id, transcript).catch((error: unknown) => {
    console.error(`${LOG} could not file unanswered questions`, error)
  })
  await announceConversationArrived({ moduleName: 'ai-call-answering', providerId: 'ai-call-answering', conversationId: input.call.id })
  const share = session.usage.inputTokens > 0 ? Math.round((session.usage.cachedTokens / session.usage.inputTokens) * 100) : 0
  console.log(`${LOG} GPT-Live call ${input.call.callSid} filed: ${seconds}s, ${session.usage.responses} backend replies, ${share}% of input from the prompt cache`)
}

/** Resolves when the call is over and filed. Never throws. */
export async function runLiveCall(input: LiveRunInput): Promise<void> {
  if (running.has(input.sessionId)) return
  running.add(input.sessionId)
  const startedAt = Date.now()
  const hangUp = () => hangUpCall(input.apiKey, input.sessionId)
  let socket: WebSocket | null = null
  const timers: Array<ReturnType<typeof setTimeout>> = []
  const typing = input.typingSound ? typingFor(input.call) : null
  const session = new LiveSession({
    send: (event) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event))
    },
    runTool: (name, args) => runLoggedTool(input.call, input.sessionId, name, args),
    hangUp,
    log: (message, detail) => console.error(`${LOG} ${message}`, detail ?? ''),
    workingStarted: typing ? () => typing.start() : undefined,
    workingStopped: typing ? () => typing.stop() : undefined,
  }, input.greeting)

  try {
    await new Promise<void>((resolve) => {
      const Ws = WebSocket as unknown as NodeWebSocketConstructor
      const ws = new Ws(attachUrl(input.sessionId), { headers: { Authorization: `Bearer ${input.apiKey}` } })
      socket = ws
      let opened = false
      ws.addEventListener('open', () => {
        opened = true
        // session.started has usually gone by before the socket attaches and is
        // only replayed if it was in the last three seconds.
        timers.push(setTimeout(() => session.greet(), 1_000))
        const limitMs = Math.max(1, input.maxCallMinutes) * 60_000
        timers.push(setTimeout(() => {
          session.instruct(wrapUpInstruction())
          session.scheduleHangUp()
        }, limitMs))
        // If the goodbye never comes, the limit is still the limit.
        timers.push(setTimeout(() => { void hangUp().catch(() => undefined) }, limitMs + 60_000))
      })
      ws.addEventListener('message', (message) => {
        let event: unknown
        try {
          event = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data))
        } catch {
          return
        }
        session.handle(event)
        if (session.closed) ws.close()
      })
      ws.addEventListener('error', (error) => console.error(`${LOG} GPT-Live sideband error`, error))
      ws.addEventListener('close', () => {
        if (!opened) {
          // Without the sideband the assistant has no tools and nothing is
          // filed. Better the number's own forwarding and voicemail: hanging up
          // this leg inside the first seconds sends the caller there.
          console.error(`${LOG} could not attach to GPT-Live session ${input.sessionId}, hanging up so the call falls back`)
          void hangUp().catch(() => undefined)
        }
        resolve()
      })
    })
  } catch (error) {
    console.error(`${LOG} GPT-Live call ${input.sessionId} failed`, error)
  } finally {
    for (const timer of timers) clearTimeout(timer)
    session.dispose()
    // dispose() has asked for the typing to stop; let that request finish.
    await typing?.idle().catch(() => undefined)
    try {
      await fileCall(input, session, startedAt)
    } catch (error) {
      console.error(`${LOG} could not file GPT-Live call ${input.call.callSid}`, error)
    }
    running.delete(input.sessionId)
  }
}

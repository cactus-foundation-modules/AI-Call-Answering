import { randomUUID } from 'crypto'
import type { CallUsage, TranscriptTurn } from './calls'
import { END_CALL_TOOL } from './live-config'

// ---------------------------------------------------------------------------
// The server's end of a GPT-Live call.
//
// OpenAI carries the caller's voice over SIP; this site keeps a second
// connection to the same session (the "sideband") for everything else. Over it
// the backend model's tool calls arrive, are run here with the same handlers the
// ElevenLabs tools use, and go back; the transcript streams past and is kept;
// and the closing message carries how long the call ran.
//
// This file is the conversation with that socket and nothing else: it is handed
// a way to send, a way to run a tool and a way to hang up, so a test can drive
// it with made-up events. lib/live-runner.ts connects it to the real thing.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

function obj(value: unknown): Json | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Joins transcript fragments into turns. The deltas carry no turn marker,
 *  only a speaker and a time, so a turn is a run of fragments from one side. */
export class TranscriptBuilder {
  private readonly turns: TranscriptTurn[] = []

  add(role: TranscriptTurn['role'], delta: string, startMs: number | null): void {
    if (!delta) return
    const last = this.turns[this.turns.length - 1]
    if (last && last.role === role) {
      last.text += delta
      return
    }
    this.turns.push({ role, text: delta, at: startMs === null ? null : Math.max(0, Math.round(startMs / 1000)) })
  }

  result(): TranscriptTurn[] {
    return this.turns
      .map((turn) => ({ ...turn, text: turn.text.replace(/\s+/g, ' ').trim() }))
      .filter((turn) => turn.text)
  }
}

export type PendingCall = { callId: string; name: string; arguments: string }

export type SessionDeps = {
  send: (event: Json) => void
  /** Runs one tool and returns what the model reads, as a JSON string. Never
   *  throws: a failed tool is words the model can act on. */
  runTool: (name: string, args: Json) => Promise<string>
  hangUp: () => Promise<void>
  log: (message: string, detail?: unknown) => void
  /** Pause before hanging up once the goodbye has stopped coming through, so
   *  the last words are not cut off. */
  hangUpQuietMs?: number
  /** Longest wait for that quiet before hanging up anyway. */
  hangUpMaxWaitMs?: number
}

/** What the voice is told when the call reaches the site's time limit. */
export function wrapUpInstruction(): string {
  return 'The call has reached its time limit. Tell the caller politely that you need to end the call now, offer to take a message if they still need help, then say goodbye.'
}

export class LiveSession {
  readonly transcript = new TranscriptBuilder()
  readonly usage: CallUsage = { seconds: 0, inputTokens: 0, cachedTokens: 0, outputTokens: 0, responses: 0 }
  closeReason = ''
  closed = false

  private readonly seen = new Set<string>()
  private readonly countedResponses = new Set<string>()
  /** Tool calls per delegation, waiting for their results to go back. */
  private readonly pending = new Map<string, Array<{ call: PendingCall; result: Promise<string> }>>()
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private greeted = false
  private hangingUp = false
  private lastSpokeAt = 0

  constructor(private readonly deps: SessionDeps, private readonly greeting: string) {}

  /** Asks the voice to greet the caller, once. Sent as soon as the session is
   *  known to be running, and again as a fallback a moment after attaching. */
  greet(): void {
    if (this.greeted || this.closed) return
    this.greeted = true
    this.deps.send({ type: 'session.commentary.append', event_id: `greeting_${randomUUID()}`, delegation_id: null, content: this.greeting })
  }

  /** Tells the voice something it must act on now (used for the time limit). */
  instruct(content: string): void {
    if (this.closed) return
    this.deps.send({ type: 'session.instructions.append', event_id: `instr_${randomUUID()}`, delegation_id: null, content })
  }

  handle(raw: unknown): void {
    const event = obj(raw)
    if (!event) return
    // Attaching replays the last three seconds. A replayed tool call must not
    // run twice.
    const eventId = text(event.event_id)
    if (eventId) {
      if (this.seen.has(eventId)) return
      this.seen.add(eventId)
    }
    switch (event.type) {
      case 'session.started':
        this.greet()
        return
      case 'session.input_transcript.delta':
        this.transcript.add('caller', text(event.delta), typeof event.start_ms === 'number' ? event.start_ms : null)
        return
      case 'session.output_transcript.delta':
        this.lastSpokeAt = Date.now()
        this.transcript.add('assistant', text(event.delta), typeof event.start_ms === 'number' ? event.start_ms : null)
        return
      case 'session.usage.updated':
        this.usage.seconds = Math.max(this.usage.seconds, count(obj(event.usage)?.seconds))
        return
      case 'session.closed':
        this.usage.seconds = Math.max(this.usage.seconds, count(obj(event.usage)?.seconds))
        this.closeReason = text(event.reason)
        this.closed = true
        return
      case 'response.event':
        this.handleDelegated(text(event.delegation_id), obj(event.event))
        return
      case 'error': {
        const error = obj(event.error)
        this.deps.log(`GPT-Live reported an error: ${text(error?.code) || text(error?.type)} ${text(error?.message)}`.trim())
        return
      }
      default:
    }
  }

  private handleDelegated(delegationId: string, inner: Json | null): void {
    if (!inner) return
    if (inner.type === 'response.output_item.done') {
      const item = obj(inner.item)
      if (item?.type !== 'function_call') return
      const call: PendingCall = { callId: text(item.call_id), name: text(item.name), arguments: text(item.arguments) }
      if (!call.callId || !call.name) return
      this.queue(delegationId, call)
      return
    }
    if (inner.type === 'response.completed' || inner.type === 'response.done') {
      const response = obj(inner.response)
      this.countUsage(text(response?.id), obj(response?.usage))
      void this.flush(delegationId)
    }
  }

  private countUsage(responseId: string, usage: Json | null): void {
    // Forwarded twice per turn (inner and outer); counted once per response.
    if (!responseId || !usage || this.countedResponses.has(responseId)) return
    this.countedResponses.add(responseId)
    this.usage.responses += 1
    this.usage.inputTokens += count(usage.input_tokens)
    this.usage.outputTokens += count(usage.output_tokens)
    this.usage.cachedTokens += count(obj(usage.input_tokens_details)?.cached_tokens)
  }

  private queue(delegationId: string, call: PendingCall): void {
    const list = this.pending.get(delegationId) ?? []
    if (list.some((entry) => entry.call.callId === call.callId)) return
    list.push({ call, result: this.execute(call) })
    this.pending.set(delegationId, list)
    // The completed event is what normally sends the results back. If it never
    // comes, the backend would sit waiting for them for ever, so send anyway.
    const previous = this.flushTimers.get(delegationId)
    if (previous) clearTimeout(previous)
    this.flushTimers.set(delegationId, setTimeout(() => { void this.flush(delegationId) }, 2_500))
  }

  private async execute(call: PendingCall): Promise<string> {
    if (call.name === END_CALL_TOOL) {
      this.scheduleHangUp()
      return JSON.stringify({ ok: true, message: 'The call will end once your goodbye has been said. Say nothing more.' })
    }
    let args: Json = {}
    try {
      args = obj(JSON.parse(call.arguments || '{}')) ?? {}
    } catch {
      return JSON.stringify({ ok: false, message: 'The details for that lookup did not come through. Ask the caller again.' })
    }
    return this.deps.runTool(call.name, args)
  }

  /** Sends every result for one delegation back, then asks the backend to
   *  carry on. All of them or none: a missing result stalls the backend. */
  private async flush(delegationId: string): Promise<void> {
    const timer = this.flushTimers.get(delegationId)
    if (timer) clearTimeout(timer)
    this.flushTimers.delete(delegationId)
    const list = this.pending.get(delegationId)
    if (!list || list.length === 0) return
    this.pending.delete(delegationId)
    const results = await Promise.all(list.map((entry) => entry.result))
    if (this.closed) return
    list.forEach((entry, index) => {
      this.deps.send({
        type: 'response.item.create',
        event_id: `out_${randomUUID()}`,
        item: { type: 'function_call_output', call_id: entry.call.callId, output: results[index] },
      })
    })
    this.deps.send({ type: 'response.create', event_id: `cont_${randomUUID()}` })
  }

  /** Waits for the goodbye to finish (no new words for a moment), then puts the
   *  phone down. */
  scheduleHangUp(): void {
    if (this.hangingUp) return
    this.hangingUp = true
    const quietMs = this.deps.hangUpQuietMs ?? 2_500
    const maxWaitMs = this.deps.hangUpMaxWaitMs ?? 15_000
    const startedAt = Date.now()
    this.lastSpokeAt = Math.max(this.lastSpokeAt, startedAt)
    const check = () => {
      if (this.closed) return
      const now = Date.now()
      if (now - this.lastSpokeAt >= quietMs || now - startedAt >= maxWaitMs) {
        this.deps.hangUp().catch((error: unknown) => this.deps.log('could not hang up a GPT-Live call', error))
        return
      }
      setTimeout(check, 250)
    }
    setTimeout(check, quietMs)
  }

  /** Stops every timer, for when the socket has gone. */
  dispose(): void {
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
    this.closed = true
  }
}

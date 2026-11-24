import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveSession, TranscriptBuilder, silenceGoodbyeInstruction } from './live-session'

type Sent = Record<string, unknown>

function harness(
  runTool: (name: string, args: Record<string, unknown>) => Promise<string> = async () => '{"ok":true}',
  silenceHangUpMs = 0,
) {
  const sent: Sent[] = []
  const hangUp = vi.fn(async () => undefined)
  const tool = vi.fn(runTool)
  const session = new LiveSession({
    send: (event) => sent.push(event),
    runTool: tool,
    hangUp,
    log: () => undefined,
    hangUpQuietMs: 100,
    hangUpMaxWaitMs: 1_000,
    silenceHangUpMs,
  }, 'Greet the caller.')
  return { session, sent, hangUp, tool }
}

const functionCall = (eventId: string, delegationId: string, callId: string, name: string, args: unknown) => ({
  type: 'response.event',
  event_id: eventId,
  delegation_id: delegationId,
  event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) } },
})

const completed = (eventId: string, delegationId: string, responseId: string, usage: Record<string, unknown>) => ({
  type: 'response.event',
  event_id: eventId,
  delegation_id: delegationId,
  event: { type: 'response.completed', response: { id: responseId, output: [], usage } },
})

describe('TranscriptBuilder', () => {
  it('joins fragments from one side into a turn, timed by its first fragment', () => {
    const builder = new TranscriptBuilder()
    builder.add('assistant', 'Hello, ', 0)
    builder.add('assistant', 'how can I help?', 800)
    builder.add('caller', 'Do you  deliver to IV2?', 4_200)
    builder.add('assistant', '', 6_000)
    expect(builder.result()).toEqual([
      { role: 'assistant', text: 'Hello, how can I help?', at: 0 },
      { role: 'caller', text: 'Do you deliver to IV2?', at: 4 },
    ])
  })
})

describe('LiveSession', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('greets once, whether or not session.started is seen', () => {
    const { session, sent } = harness()
    session.handle({ type: 'session.started', event_id: 'e1' })
    session.greet()
    expect(sent.filter((event) => event.type === 'session.commentary.append')).toHaveLength(1)
    expect(sent[0]).toMatchObject({ delegation_id: null, content: 'Greet the caller.' })
  })

  it('runs every tool of a delegation, sends all results, then asks the backend to carry on', async () => {
    const { session, sent, tool } = harness(async (name) => JSON.stringify({ ok: true, tool: name }))
    session.handle(functionCall('e1', 'd1', 'call_a', 'search_products', { query: 'desk' }))
    session.handle(functionCall('e2', 'd1', 'call_b', 'get_faqs', {}))
    session.handle(completed('e3', 'd1', 'resp_1', { input_tokens: 5000, output_tokens: 40, input_tokens_details: { cached_tokens: 4600 } }))
    await vi.runAllTimersAsync()

    expect(tool).toHaveBeenCalledWith('search_products', { query: 'desk' })
    const outputs = sent.filter((event) => event.type === 'response.item.create')
    expect(outputs.map((event) => (event.item as { call_id: string }).call_id)).toEqual(['call_a', 'call_b'])
    expect(sent.at(-1)?.type).toBe('response.create')
    expect(sent.filter((event) => event.type === 'response.create')).toHaveLength(1)
  })

  it('never runs a replayed tool call twice and counts each response\'s usage once', async () => {
    const { session, tool } = harness()
    const call = functionCall('e1', 'd1', 'call_a', 'list_categories', {})
    session.handle(call)
    session.handle(call)
    session.handle({ ...call, event_id: 'e9' })
    const done = completed('e2', 'd1', 'resp_1', { input_tokens: 5000, output_tokens: 40, input_tokens_details: { cached_tokens: 4600 } })
    session.handle(done)
    // Forwarded a second time (outer envelope) under a new event id.
    session.handle({ ...done, event_id: 'e3' })
    await vi.runAllTimersAsync()
    expect(tool).toHaveBeenCalledTimes(1)
    expect(session.usage).toMatchObject({ responses: 1, inputTokens: 5000, cachedTokens: 4600, outputTokens: 40 })
  })

  it('sends results back even if the completed event never comes', async () => {
    const { session, sent } = harness()
    session.handle(functionCall('e1', 'd1', 'call_a', 'list_categories', {}))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sent.some((event) => event.type === 'response.create')).toBe(true)
  })

  it('tells the model when a tool\'s details did not parse, without running it', async () => {
    const { session, sent, tool } = harness()
    session.handle({
      type: 'response.event', event_id: 'e1', delegation_id: 'd1',
      event: { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'c1', name: 'search_products', arguments: '{nope' } },
    })
    session.handle(completed('e2', 'd1', 'r1', {}))
    await vi.runAllTimersAsync()
    expect(tool).not.toHaveBeenCalled()
    const output = sent.find((event) => event.type === 'response.item.create')?.item as { output: string }
    expect(JSON.parse(output.output)).toMatchObject({ ok: false })
  })

  it('hangs up after end_call once the goodbye has finished', async () => {
    const { session, hangUp } = harness()
    session.handle(functionCall('e1', 'd1', 'c1', 'end_call', {}))
    session.handle(completed('e2', 'd1', 'r1', {}))
    await vi.advanceTimersByTimeAsync(50)
    session.handle({ type: 'session.output_transcript.delta', event_id: 'e3', delta: 'Bye now!', start_ms: 9_000 })
    expect(hangUp).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(hangUp).toHaveBeenCalledTimes(1)
  })

  it('keeps the transcript and the call length the session reports', () => {
    const { session } = harness()
    session.handle({ type: 'session.input_transcript.delta', event_id: 'a', delta: 'Hi there', start_ms: 1_000 })
    session.handle({ type: 'session.output_transcript.delta', event_id: 'b', delta: 'Hello!', start_ms: 2_000 })
    session.handle({ type: 'session.closed', event_id: 'c', reason: 'remote_hangup', usage: { seconds: 42 } })
    expect(session.closed).toBe(true)
    expect(session.closeReason).toBe('remote_hangup')
    expect(session.usage.seconds).toBe(42)
    expect(session.transcript.result()).toHaveLength(2)
  })

  describe('silence on the line', () => {
    const asked = (sent: Sent[]) => sent.some((event) => event.type === 'session.instructions.append' && event.content === silenceGoodbyeInstruction())
    let n = 0
    const callerSays = (session: LiveSession, delta: string) => session.handle({ type: 'session.input_transcript.delta', event_id: `in${n++}`, delta, start_ms: 0 })
    const voiceSays = (session: LiveSession, delta: string) => session.handle({ type: 'session.output_transcript.delta', event_id: `out${n++}`, delta, start_ms: 0 })

    it('says goodbye and hangs up once nobody has said anything for the limit', async () => {
      const { session, sent, hangUp } = harness(undefined, 30_000)
      session.watchSilence()
      await vi.advanceTimersByTimeAsync(29_000)
      expect(asked(sent)).toBe(false)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(asked(sent)).toBe(true)
      expect(session.endedForSilence).toBe(true)
      expect(hangUp).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(hangUp).toHaveBeenCalledTimes(1)
    })

    it('starts counting again whenever the caller speaks', async () => {
      const { session, sent } = harness(undefined, 30_000)
      session.watchSilence()
      await vi.advanceTimersByTimeAsync(25_000)
      callerSays(session, 'Hello?')
      await vi.advanceTimersByTimeAsync(25_000)
      expect(asked(sent)).toBe(false)
      await vi.advanceTimersByTimeAsync(7_000)
      expect(asked(sent)).toBe(true)
    })

    it('does not count while the voice is talking or a lookup is being worked on', async () => {
      const { session, sent } = harness(async () => new Promise<string>(() => undefined), 10_000)
      session.watchSilence()
      // Twenty seconds of the voice asking whether anybody is there.
      for (let i = 0; i < 20; i++) {
        voiceSays(session, 'Are you still there? ')
        await vi.advanceTimersByTimeAsync(1_000)
      }
      expect(asked(sent)).toBe(false)
      // A lookup that never finishes holds the count as well.
      session.handle(functionCall('l1', 'd9', 'c9', 'search_products', { query: 'desk' }))
      await vi.advanceTimersByTimeAsync(60_000)
      expect(asked(sent)).toBe(false)
    })

    it('never hangs up for silence when the site has it off', async () => {
      const { session, sent, hangUp } = harness(undefined, 0)
      session.watchSilence()
      await vi.advanceTimersByTimeAsync(600_000)
      expect(asked(sent)).toBe(false)
      expect(hangUp).not.toHaveBeenCalled()
    })

    it('stops watching once the call has closed', async () => {
      const { session, sent } = harness(undefined, 10_000)
      session.watchSilence()
      session.handle({ type: 'session.closed', event_id: 'closed1', reason: 'remote_hangup' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(asked(sent)).toBe(false)
    })
  })
})

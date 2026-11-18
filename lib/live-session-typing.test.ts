import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveSession } from './live-session'

// The typing sound's start/stop rules on a GPT-Live call. Every scenario is a
// made-up event stream; lib/typing-player.ts and lib/live-conference.ts turn
// the two hooks into Twilio requests.

function harness(runTool: () => Promise<string> = async () => '{"ok":true}') {
  const sent: Array<Record<string, unknown>> = []
  const calls: string[] = []
  const session = new LiveSession({
    send: (event) => sent.push(event),
    runTool: vi.fn(runTool),
    hangUp: vi.fn(async () => undefined),
    log: () => undefined,
    hangUpQuietMs: 100,
    hangUpMaxWaitMs: 1_000,
    typingQuietMs: 500,
    typingMaxMs: 5_000,
    workingStarted: () => calls.push('start'),
    workingStopped: () => calls.push('stop'),
  }, 'Greet the caller.')
  return { session, sent, calls }
}

let n = 0
const id = () => `ev_${++n}`

const delegated = (delegationId: string, type: string, extra: Record<string, unknown> = {}) => ({
  type: 'response.event', event_id: id(), delegation_id: delegationId, event: { type, ...extra },
})
const begins = (delegationId: string) => delegated(delegationId, 'response.created', { response: { id: `resp_${delegationId}` } })
const done = (delegationId: string, responseId: string) =>
  delegated(delegationId, 'response.done', { response: { id: responseId, usage: { input_tokens: 1, output_tokens: 1 } } })
const toolCall = (delegationId: string, callId: string) => delegated(delegationId, 'response.output_item.done', {
  item: { type: 'function_call', call_id: callId, name: 'search_products', arguments: '{"query":"chair"}' },
})
const speaks = (words: string) => ({ type: 'session.output_transcript.delta', event_id: id(), delta: words })

describe('LiveSession typing sound', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts once a question is handed over and the voice has gone quiet', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    vi.advanceTimersByTime(499)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['start'])
    expect(session.typingPlaying).toBe(true)
  })

  it('waits out the voice saying "let me check" before it starts', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    vi.advanceTimersByTime(200)
    session.handle(speaks('Let me just '))
    vi.advanceTimersByTime(400)
    session.handle(speaks('check that for you.'))
    vi.advanceTimersByTime(499)
    expect(calls).toEqual([])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual(['start'])
  })

  it('stops on the first word of the answer', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    vi.advanceTimersByTime(600)
    session.handle(speaks('We have three in stock.'))
    expect(calls).toEqual(['start', 'stop'])
    expect(session.typingPlaying).toBe(false)
  })

  it('stops when the thinking model has finished, even before the voice speaks', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    vi.advanceTimersByTime(600)
    session.handle(done('d1', 'resp_1'))
    expect(calls).toEqual(['start', 'stop'])
    vi.advanceTimersByTime(10_000)
    expect(calls).toEqual(['start', 'stop'])
  })

  it('keeps playing through a lookup: a response that asked for tools is not the answer, however often it is forwarded', async () => {
    let finish: (value: string) => void = () => undefined
    const { session, calls, sent } = harness(() => new Promise<string>((resolve) => { finish = resolve }))
    session.handle(begins('d1'))
    vi.advanceTimersByTime(600)
    session.handle(toolCall('d1', 'call_1'))
    // GPT-Live forwards each done event twice.
    session.handle(done('d1', 'resp_1'))
    session.handle(done('d1', 'resp_1b'))
    expect(calls).toEqual(['start'])
    finish('{"ok":true}')
    await vi.advanceTimersByTimeAsync(0)
    expect(sent.some((event) => event.type === 'response.create')).toBe(true)
    expect(calls).toEqual(['start'])
    session.handle(begins('d1'))
    session.handle(done('d1', 'resp_2'))
    expect(calls).toEqual(['start', 'stop'])
  })

  it('stops at the time limit and does not start again for the same question', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    vi.advanceTimersByTime(500)
    vi.advanceTimersByTime(5_000)
    expect(calls).toEqual(['start', 'stop'])
    session.handle(speaks('Still looking.'))
    vi.advanceTimersByTime(5_000)
    expect(calls).toEqual(['start', 'stop'])
  })

  it('never plays twice at once, whatever the order of events', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    session.handle(begins('d2'))
    vi.advanceTimersByTime(600)
    session.handle(begins('d3'))
    vi.advanceTimersByTime(600)
    session.handle(speaks('Hm.'))
    vi.advanceTimersByTime(600)
    session.handle(speaks('Right.'))
    session.handle(speaks(' So.'))
    vi.advanceTimersByTime(600)
    let playing = 0
    for (const call of calls) {
      playing += call === 'start' ? 1 : -1
      expect(playing === 0 || playing === 1).toBe(true)
    }
    expect(calls[0]).toBe('start')
  })

  it('comes back after a word in the middle of a long lookup', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    vi.advanceTimersByTime(600)
    session.handle(speaks('Bear with me.'))
    vi.advanceTimersByTime(500)
    expect(calls).toEqual(['start', 'stop', 'start'])
  })

  it('stops when the session closes, and starts nothing after', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    vi.advanceTimersByTime(600)
    session.handle({ type: 'session.closed', event_id: id(), reason: 'hangup', usage: { seconds: 30 } })
    expect(calls).toEqual(['start', 'stop'])
    session.handle(begins('d2'))
    vi.advanceTimersByTime(5_000)
    expect(calls).toEqual(['start', 'stop'])
  })

  it('stops when the socket goes, and when the call is being ended', () => {
    const first = harness()
    first.session.handle(begins('d1'))
    vi.advanceTimersByTime(600)
    first.session.dispose()
    expect(first.calls).toEqual(['start', 'stop'])

    const second = harness()
    second.session.handle(begins('d1'))
    vi.advanceTimersByTime(600)
    second.session.scheduleHangUp()
    expect(second.calls).toEqual(['start', 'stop'])
    second.session.handle(begins('d2'))
    vi.advanceTimersByTime(5_000)
    expect(second.calls).toEqual(['start', 'stop'])
  })

  it('a quiet wait that is cut short by the answer never starts at all', () => {
    const { session, calls } = harness()
    session.handle(begins('d1'))
    vi.advanceTimersByTime(300)
    session.handle(done('d1', 'resp_1'))
    vi.advanceTimersByTime(5_000)
    expect(calls).toEqual([])
  })

  it('does nothing when the site has the typing sound off', () => {
    const session = new LiveSession({ send: () => undefined, runTool: async () => '{}', hangUp: async () => undefined, log: () => undefined }, 'Hi')
    session.handle(begins('d1'))
    vi.advanceTimersByTime(30_000)
    expect(session.typingPlaying).toBe(false)
  })
})

import { createHmac } from 'crypto'
import { describe, expect, it } from 'vitest'
import { fallbackSummary, parsePostCallPayload, toTranscript, verifySignature } from './post-call'

const secret = 'whsec_test'
const body = JSON.stringify({ type: 'post_call_transcription', data: { agent_id: 'a', conversation_id: 'c', transcript: [] } })
const now = 1_800_000_000

function sign(timestamp: number, payload: string, key = secret): string {
  return `t=${timestamp},v0=${createHmac('sha256', key).update(`${timestamp}.${payload}`).digest('hex')}`
}

describe('verifySignature', () => {
  it('accepts a correct, fresh signature', () => {
    expect(verifySignature(body, sign(now, body), secret, now)).toBe(true)
  })
  it('rejects a tampered body', () => {
    expect(verifySignature(`${body} `, sign(now, body), secret, now)).toBe(false)
  })
  it('rejects the wrong secret', () => {
    expect(verifySignature(body, sign(now, body, 'other'), secret, now)).toBe(false)
  })
  it('rejects a stale timestamp', () => {
    expect(verifySignature(body, sign(now - 3600, body), secret, now)).toBe(false)
  })
  it('rejects missing pieces', () => {
    expect(verifySignature(body, null, secret, now)).toBe(false)
    expect(verifySignature(body, sign(now, body), null, now)).toBe(false)
    expect(verifySignature(body, 'garbage', secret, now)).toBe(false)
  })
})

describe('parsePostCallPayload', () => {
  it('parses a transcript payload and tolerates extra fields', () => {
    const parsed = parsePostCallPayload(body.replace('"type"', '"extra":1,"type"'))
    expect(parsed?.data.conversation_id).toBe('c')
  })
  it('refuses nonsense', () => {
    expect(parsePostCallPayload('nope')).toBeNull()
    expect(parsePostCallPayload('{"type":"x"}')).toBeNull()
  })
})

describe('toTranscript', () => {
  it('maps roles and drops empty and tool-only turns', () => {
    const turns = toTranscript([
      { role: 'agent', message: 'Hello', time_in_call_secs: 0 },
      { role: 'user', message: '  ', time_in_call_secs: 2 },
      { role: 'user', message: 'A desk please', time_in_call_secs: 4 },
      { role: 'tool', message: 'x' },
    ])
    expect(turns).toEqual([
      { role: 'assistant', text: 'Hello', at: 0 },
      { role: 'caller', text: 'A desk please', at: 4 },
    ])
  })
})

describe('fallbackSummary', () => {
  it('quotes the first thing the caller said', () => {
    expect(fallbackSummary([{ role: 'caller', text: 'Where is my order', at: 1 }])).toContain('Where is my order')
    expect(fallbackSummary([])).toBe('The caller did not say anything.')
  })
})

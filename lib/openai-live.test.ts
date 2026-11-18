import { createHmac } from 'crypto'
import { describe, expect, it } from 'vitest'
import { parseIncomingCall, verifyOpenAiWebhook } from './openai-live'

const key = Buffer.from('a-very-secret-key-for-testing-only')
const secret = `whsec_${key.toString('base64')}`

function sign(id: string, timestamp: number, body: string, withKey: Buffer = key): string {
  return `v1,${createHmac('sha256', withKey).update(`${id}.${timestamp}.${body}`).digest('base64')}`
}

describe('verifyOpenAiWebhook', () => {
  const body = '{"type":"live.transport.incoming"}'
  const now = 1_800_000_000

  it('accepts a fresh, correctly signed delivery', () => {
    expect(verifyOpenAiWebhook(body, { id: 'wh_1', timestamp: String(now), signature: sign('wh_1', now, body) }, secret, now)).toBe(true)
  })

  it('accepts when any one of several signatures matches (secret rotation)', () => {
    const signature = `v1,bm90LWl0 ${sign('wh_1', now, body)}`
    expect(verifyOpenAiWebhook(body, { id: 'wh_1', timestamp: String(now), signature }, secret, now)).toBe(true)
  })

  it('refuses a changed body, another id, another key, an old timestamp or a missing secret', () => {
    const signature = sign('wh_1', now, body)
    expect(verifyOpenAiWebhook(`${body} `, { id: 'wh_1', timestamp: String(now), signature }, secret, now)).toBe(false)
    expect(verifyOpenAiWebhook(body, { id: 'wh_2', timestamp: String(now), signature }, secret, now)).toBe(false)
    expect(verifyOpenAiWebhook(body, { id: 'wh_1', timestamp: String(now), signature: sign('wh_1', now, body, Buffer.from('other')) }, secret, now)).toBe(false)
    expect(verifyOpenAiWebhook(body, { id: 'wh_1', timestamp: String(now), signature }, secret, now + 3600)).toBe(false)
    expect(verifyOpenAiWebhook(body, { id: 'wh_1', timestamp: String(now), signature }, null, now)).toBe(false)
  })
})

describe('parseIncomingCall', () => {
  const event = (type: string, data: Record<string, unknown>) => JSON.stringify({ object: 'event', id: 'evt_1', type, data })

  it('reads the session and SIP headers from the current and the older event name', () => {
    const headers = [{ name: 'X-Cactus-Call', value: 'CA1' }]
    expect(parseIncomingCall(event('live.transport.incoming', { type: 'sip', session_id: 'live_1', sip_headers: headers })))
      .toEqual({ sessionId: 'live_1', sipHeaders: headers })
    expect(parseIncomingCall(event('live.call.incoming', { session_id: 'live_2' })))
      .toEqual({ sessionId: 'live_2', sipHeaders: [] })
  })

  it('ignores other events, other transports and nonsense', () => {
    expect(parseIncomingCall(event('response.completed', { session_id: 'x' }))).toBeNull()
    expect(parseIncomingCall(event('live.transport.incoming', { type: 'webrtc', session_id: 'x' }))).toBeNull()
    expect(parseIncomingCall('not json')).toBeNull()
  })
})

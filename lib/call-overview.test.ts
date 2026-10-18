import { describe, expect, it } from 'vitest'
import { buildOverview, buildTranscriptText, formatDuration } from './call-overview'
import type { CallRecord } from './calls'

const base: CallRecord = {
  id: '1',
  callSid: 'CA1',
  conversationId: 'conv',
  fromNumber: '+447700900123',
  toNumber: '+441234567890',
  status: 'completed',
  startedAt: new Date('2026-10-18T10:00:00Z'),
  durationSeconds: 95,
  summary: 'Asked about standing desks.',
  transcript: [
    { role: 'assistant', text: 'Hello', at: 0 },
    { role: 'caller', text: 'Do you do standing desks?', at: 3 },
  ],
  callerName: '',
  callerEmail: '',
  callerPhone: '',
  callbackNeeded: false,
  callbackReason: '',
  handledAt: null,
  readAt: null,
  verifiedOrders: [],
  verifiedContact: { name: '', email: '', phone: '' },
  failedOrderChecks: 0,
  emailsSent: 0,
  emailedTo: '',
  updatedAt: new Date('2026-10-18T10:02:00Z'),
}

describe('formatDuration', () => {
  it('reads naturally', () => {
    expect(formatDuration(0)).toBe('under a second')
    expect(formatDuration(45)).toBe('45 sec')
    expect(formatDuration(120)).toBe('2 min')
    expect(formatDuration(95)).toBe('1 min 35 sec')
  })
})

describe('buildOverview', () => {
  it('summarises an ordinary call', () => {
    const text = buildOverview(base)
    expect(text).toContain('Asked about standing desks.')
    expect(text).toContain('Caller: +447700900123')
    expect(text).toContain('Length: 1 min 35 sec')
    expect(text).not.toContain('CALLBACK')
  })
  it('puts the callback details where staff will see them', () => {
    const text = buildOverview({ ...base, callbackNeeded: true, callerName: 'Jo Bloggs', callerEmail: 'jo@example.com', callbackReason: 'Wants a bulk quote' })
    expect(text).toContain('CALLBACK REQUESTED - please get back to this caller')
    expect(text).toContain('Name: Jo Bloggs')
    expect(text).toContain('Email: jo@example.com')
    expect(text).toContain('Caller: Jo Bloggs (+447700900123)')
  })
  it('records verified and failed order checks', () => {
    const text = buildOverview({ ...base, verifiedOrders: ['DW-1'], failedOrderChecks: 2 })
    expect(text).toContain('DW-1')
    expect(text).toContain('did not match: 2')
  })
  it('says a live call is live', () => {
    expect(buildOverview({ ...base, status: 'in_progress' })).toContain('in progress')
  })
})

describe('buildTranscriptText', () => {
  it('labels each side', () => {
    expect(buildTranscriptText(base)).toBe('Assistant: Hello\nCaller: Do you do standing desks?')
    expect(buildTranscriptText({ ...base, transcript: [] })).toBe('No transcript was recorded.')
  })
})

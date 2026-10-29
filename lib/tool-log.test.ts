import { describe, expect, it } from 'vitest'
import { MAX_RESULT_CHARS, describeToolCall, parseToolLog, toolLogEntry } from './tool-log'

describe('toolLogEntry', () => {
  it('drops the call ids and keeps what was asked', () => {
    const entry = toolLogEntry({
      tool: 'get_payment_info',
      body: { call_sid: 'CA1', conversation_id: 'c1' },
      result: { ok: true, methods: [] },
      ms: 120.4,
      failed: false,
    })
    expect(entry.input).toEqual({})
    expect(entry.result).toEqual({ ok: true, methods: [] })
    expect(entry.ms).toBe(120)
  })

  it('keeps only the outcome of an order lookup', () => {
    const entry = toolLogEntry({
      tool: 'lookup_caller_orders',
      body: {},
      result: { ok: true, orders: [{ address: '1 High Street' }, {}], message: 'Recognised.' },
      ms: 10,
      failed: false,
    })
    expect(entry.result).toEqual({ ok: true, message: 'Recognised.', ordersFound: 2 })
    expect(JSON.stringify(entry)).not.toContain('High Street')
  })

  it('cuts down a long product answer', () => {
    const entry = toolLogEntry({
      tool: 'get_product',
      body: { product_id: 'p1' },
      result: { ok: true, text: 'x'.repeat(MAX_RESULT_CHARS * 2) },
      ms: 10,
      failed: false,
    })
    expect(entry.result.truncated).toBe(true)
  })
})

describe('describeToolCall', () => {
  it('says what was asked and what came back', () => {
    const [entry] = parseToolLog([{ tool: 'get_faqs', at: 12, ms: 5, input: { query: 'returns' }, result: { ok: false, message: 'None found.' }, failed: false }])
    expect(describeToolCall(entry!)).toBe('[Looked up get_faqs (query: returns): nothing - None found.]')
  })
})

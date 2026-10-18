import { afterEach, describe, expect, it, vi } from 'vitest'
import { innerTwiml, isOutOfCredit } from './elevenlabs'

describe('innerTwiml', () => {
  it('peels the Response wrapper off a connection', () => {
    const document = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://x"/></Connect></Response>'
    expect(innerTwiml(document)).toBe('<Connect><Stream url="wss://x"/></Connect>')
  })
  it('refuses a reply that connects nobody', () => {
    expect(innerTwiml('<Response><Say>Hello</Say></Response>')).toBeNull()
    expect(innerTwiml('not xml')).toBeNull()
  })
})

describe('isOutOfCredit', () => {
  afterEach(() => vi.unstubAllGlobals())
  const withAllowance = (count: number, limit: number, extend = false) =>
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ character_count: count, character_limit: limit, can_extend_character_limit: extend }), { status: 200 })))

  it('treats a nearly spent account as out of credit', async () => {
    withAllowance(98_500, 100_000)
    expect(await isOutOfCredit('key')).toBe(true)
  })
  it('keeps an account with room to spare', async () => {
    withAllowance(50_000, 100_000)
    expect(await isOutOfCredit('key')).toBe(false)
  })
  it('never turns away an account that may go over its limit', async () => {
    withAllowance(100_000, 100_000, true)
    expect(await isOutOfCredit('key')).toBe(false)
  })
})

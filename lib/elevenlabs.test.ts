import { describe, expect, it } from 'vitest'
import { innerTwiml } from './elevenlabs'

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

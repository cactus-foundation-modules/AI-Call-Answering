import { describe, expect, it } from 'vitest'
import { MAX_TEXT_CHARS, composeText, textableNumber } from './sms'

describe('textableNumber', () => {
  it('takes a UK mobile', () => {
    expect(textableNumber('+447700900123')).toEqual({ ok: true, to: '+447700900123' })
  })

  it('refuses a UK landline and a withheld number', () => {
    expect(textableNumber('+442081380512').ok).toBe(false)
    expect(textableNumber('').ok).toBe(false)
    expect(textableNumber('anonymous').ok).toBe(false)
  })
})

describe('composeText', () => {
  it('keeps every link whole and shortens the note', () => {
    const link = 'https://shop.test/api/m/ai-call-answering/public/basket?t=abcdefghijklmnopqrstuvwx'
    const text = composeText('word '.repeat(200), [link, link], 'Deskwell')
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(text.split(link)).toHaveLength(3)
    expect(text.endsWith('Deskwell')).toBe(true)
  })

  it('leaves a short note alone', () => {
    expect(composeText('Here you go.', ['https://x.test/a'], 'Shop')).toBe('Here you go.\n\nhttps://x.test/a\nShop')
  })
})

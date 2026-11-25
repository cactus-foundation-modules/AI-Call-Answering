import { describe, expect, it } from 'vitest'
import { MAX_TEXT_CHARS, composeText, textSignOff, textableNumber } from './sms'

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
    const text = composeText('word '.repeat(200), [{ label: 'Basket', url: link }, { label: null, url: link }], 'Deskwell')
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS)
    expect(text.split(link)).toHaveLength(3)
    expect(text.endsWith('Deskwell')).toBe(true)
  })

  it('leaves a short note alone, each product named above its link (the live-site "garbled mess")', () => {
    expect(composeText('Here you go.', [{ label: 'Oslo Air Desk', url: 'https://x.test/a' }, { label: null, url: 'https://x.test/b' }], 'Shop.co.uk'))
      .toBe('Here you go.\n\nOslo Air Desk\nhttps://x.test/a\n\nhttps://x.test/b\n\nShop.co.uk')
  })
})

describe('textSignOff', () => {
  it('signs off with the site address in the business\'s own capitals', () => {
    expect(textSignOff('Deskwell', 'https://www.deskwell.co.uk')).toBe('Deskwell.co.uk')
    expect(textSignOff('Deskwell', null)).toBe('Deskwell')
  })
})

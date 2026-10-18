import { describe, expect, it } from 'vitest'
import {
  escapeLike,
  isPlausibleEmail,
  normaliseCompany,
  normaliseOrderNumber,
  normalisePostcode,
  plainText,
  searchTokens,
  truncate,
} from './text'

describe('normalisePostcode', () => {
  it('treats every spelling of one postcode as the same', () => {
    expect(normalisePostcode('sw1a 1aa')).toBe('SW1A1AA')
    expect(normalisePostcode('SW1A-1AA')).toBe('SW1A1AA')
    expect(normalisePostcode(' sw1a1aa ')).toBe('SW1A1AA')
  })
})

describe('normaliseOrderNumber', () => {
  it('ignores case, spaces, hashes and a spoken "order"', () => {
    expect(normaliseOrderNumber('#dw-1042')).toBe('DW1042')
    expect(normaliseOrderNumber('DW 1042')).toBe('DW1042')
    expect(normaliseOrderNumber('order number dw1042')).toBe('DW1042')
  })
})

describe('normaliseCompany', () => {
  it('drops case, punctuation and the legal suffix', () => {
    expect(normaliseCompany('Smith & Sons Ltd.')).toBe(normaliseCompany('smith and sons limited'))
  })
  it('keeps different companies apart', () => {
    expect(normaliseCompany('Acme Desks')).not.toBe(normaliseCompany('Acme Chairs'))
  })
})

describe('isPlausibleEmail', () => {
  it('accepts an address and rejects a near miss', () => {
    expect(isPlausibleEmail('jo@example.co.uk')).toBe(true)
    expect(isPlausibleEmail('jo@example')).toBe(false)
    expect(isPlausibleEmail('jo example.com')).toBe(false)
  })
})

describe('plainText', () => {
  it('flattens markup and entities', () => {
    expect(plainText('<p>Strong &amp; <b>light</b></p><p>Two</p>')).toBe('Strong & light\nTwo')
  })
  it('returns empty for nothing', () => {
    expect(plainText(null)).toBe('')
  })
})

describe('truncate', () => {
  it('leaves short text alone and cuts long text on a word', () => {
    expect(truncate('short', 20)).toBe('short')
    expect(truncate('one two three four five six', 15)).toBe('one two three…')
  })
})

describe('searchTokens', () => {
  it('drops filler and duplicates and caps the count', () => {
    expect(searchTokens('I need a standing desk for my desk')).toEqual(['standing', 'desk'])
    expect(searchTokens('a b c d e f g h i j k l m nn oo pp qq', 3)).toEqual(['nn', 'oo', 'pp'])
  })
})

describe('escapeLike', () => {
  it('makes wildcards literal', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\')
  })
})

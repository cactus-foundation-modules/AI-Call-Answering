import { describe, expect, it } from 'vitest'
import {
  phoneMatchKey,
  orderNumbersMatch,
  emailsMatch,
  companiesMatch,
  escapeLike,
  isPlausibleEmail,
  normaliseCompany,
  normaliseOrderNumber,
  normalisePostcode,
  postcodesMatch,
  spokenPostcodeToText,
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

describe('postcodesMatch', () => {
  it('accepts the same postcode however it is spelled', () => {
    expect(postcodesMatch('po7 3dl', 'PO7 3DL')).toBe(true)
  })
  it('puts back an O the phone line heard as a zero', () => {
    expect(postcodesMatch('P073DL', 'PO7 3DL')).toBe(true)
  })
  it('fixes letters and digits in the inward code', () => {
    expect(postcodesMatch('PO7 3D1', 'PO7 3DI')).toBe(true)
    expect(postcodesMatch('PO7 ODL', 'PO7 0DL')).toBe(true)
    expect(postcodesMatch('PO7 5DL', 'PO7 3DL')).toBe(true) // one digit out is close enough
  })
  it('understands a postcode spelled out in words', () => {
    expect(postcodesMatch('papa oh seven three delta lima', 'PO7 3DL')).toBe(true)
    expect(postcodesMatch('S double zero one 1AA', 'S001 1AA')).toBe(true)
  })
  it('still rejects a different postcode', () => {
    expect(postcodesMatch('PO8 4DL', 'PO7 3DL')).toBe(false)
    expect(postcodesMatch('SW1A 1AA', 'PO7 3DL')).toBe(false)
  })
})

describe('spokenPostcodeToText', () => {
  it('leaves a written postcode alone', () => {
    expect(spokenPostcodeToText('PO7 3DL')).toBe('po73dl')
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

describe('phoneMatchKey', () => {
  it('agrees across caller-ID and order formats', () => {
    const key = phoneMatchKey('+447703822803')
    expect(key).toBe('7703822803')
    expect(phoneMatchKey('07703822803')).toBe(key)
    expect(phoneMatchKey('07703 822 803')).toBe(key)
    expect(phoneMatchKey('+44 (0)7703 822803')).toBe(key)
    expect(phoneMatchKey('01670353124')).toBe('1670353124')
    expect(phoneMatchKey('+441670353124')).toBe('1670353124')
  })
  it('refuses withheld and too-short numbers', () => {
    expect(phoneMatchKey('')).toBeNull()
    expect(phoneMatchKey(null)).toBeNull()
    expect(phoneMatchKey('withheld')).toBeNull()
    expect(phoneMatchKey('123456')).toBeNull()
  })
})

describe('fuzzy matching', () => {
  it('matches padded and prefixed order numbers', () => {
    expect(orderNumbersMatch('dw000123', '123')).toBe(true)
    expect(orderNumbersMatch('123', 'DW000123')).toBe(true)
    expect(orderNumbersMatch('order number 0123', 'DW123')).toBe(true)
    expect(orderNumbersMatch('dw124', 'DW123')).toBe(false)
    expect(orderNumbersMatch('xy123', 'DW123')).toBe(false)
  })
  it('allows one slip in a postcode', () => {
    expect(postcodesMatch('PO7 3DM', 'PO7 3DL')).toBe(true)
    expect(postcodesMatch('PO7 3XX', 'PO7 3DL')).toBe(false)
    expect(postcodesMatch('PO7 3DM', 'PO7 3DL')).toBe(true)
  })
  it('allows a slip in a long email but not a short one', () => {
    expect(emailsMatch('jo.bloggs@exmple.com', 'jo.bloggs@example.com')).toBe(true)
    expect(emailsMatch('jo@ex.com', 'jim@ex.com')).toBe(false)
  })
  it('allows a near company name', () => {
    expect(companiesMatch('bloggs plumbing', 'blogs plumbing')).toBe(true)
    expect(companiesMatch('bloggs plumbing', 'smith roofing')).toBe(false)
  })
})

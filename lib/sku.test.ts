import { describe, expect, it } from 'vitest'
import { normaliseSpokenSku, skuMatch, skuSearchDigits, splitSku } from './sku'

describe('normaliseSpokenSku', () => {
  it('drops case, spaces and hyphens', () => {
    expect(normaliseSpokenSku('o-p 000378')).toBe('OP000378')
  })
  it('turns spoken alphabet and digit words into characters', () => {
    expect(normaliseSpokenSku('oscar papa zero zero zero three seven eight')).toBe('OP000378')
  })
})

describe('splitSku', () => {
  it('separates the letters from the number, dropping leading zeros', () => {
    expect(splitSku('OP000378')).toEqual({ prefix: 'OP', digits: '378' })
  })
  it('is null for a code with no trailing digits', () => {
    expect(splitSku('PRISM')).toBeNull()
  })
})

describe('skuSearchDigits', () => {
  it('needs at least three digits', () => {
    expect(skuSearchDigits('OP000378')).toBe('378')
    expect(skuSearchDigits('OP12')).toBeNull()
  })
})

describe('skuMatch', () => {
  it('is exact once punctuation and case go', () => {
    expect(skuMatch('op 000378', 'OP-000378')).toBe('exact')
  })
  it('is close for a mis-heard letter with the same digits', () => {
    expect(skuMatch('LP000378', 'OP000378')).toBe('close')
  })
  it('is close when the letters were left off', () => {
    expect(skuMatch('000378', 'OP000378')).toBe('close')
  })
  it('is close for O against 0', () => {
    expect(skuMatch('OP00O378', 'OP000378')).toBe('close')
  })
  it('is no match for different digits or a different prefix', () => {
    expect(skuMatch('OP000379', 'OP000378')).toBeNull()
    expect(skuMatch('ABC000378', 'OP000378')).toBeNull()
  })
})

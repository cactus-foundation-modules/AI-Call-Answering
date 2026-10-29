import { describe, expect, it } from 'vitest'
import { numberForms, spokenDate } from './caller-history'

describe('numberForms', () => {
  it('gives the national form of a UK number, as chat and the inbox store it', () => {
    expect(numberForms('+447700900123')).toEqual(['+447700900123', '07700900123'])
  })

  it('has nothing for a withheld number', () => {
    expect(numberForms('withheld')).toEqual([])
  })
})

describe('spokenDate', () => {
  it('reads as a person would say it', () => {
    expect(spokenDate(new Date('2026-10-27T10:00:00Z'))).toBe('Tuesday 27 October')
  })
})

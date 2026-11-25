import { describe, expect, it } from 'vitest'
import { titleCaseName } from './name-case'

describe('titleCaseName', () => {
  it('capitalises a name typed in small letters', () => {
    expect(titleCaseName('chris')).toBe('Chris')
    expect(titleCaseName('jo bloggs')).toBe('Jo Bloggs')
  })

  it('capitalises after a hyphen or an apostrophe', () => {
    expect(titleCaseName("mary-jane o'neil")).toBe("Mary-Jane O'Neil")
    expect(titleCaseName('o’brien')).toBe('O’Brien')
  })

  it('brings an all-capitals name down to ordinary case', () => {
    expect(titleCaseName('CHRIS')).toBe('Chris')
    expect(titleCaseName("MARY-JANE O'NEIL")).toBe("Mary-Jane O'Neil")
  })

  it('leaves a name that already mixes cases exactly as given', () => {
    expect(titleCaseName('McDonald')).toBe('McDonald')
    expect(titleCaseName('DeVries')).toBe('DeVries')
    expect(titleCaseName('Mary-Jane')).toBe('Mary-Jane')
    expect(titleCaseName('chris McDonald')).toBe('Chris McDonald')
  })

  it('handles accents, spacing and nothing at all', () => {
    expect(titleCaseName('  zoë   ÉLODIE ')).toBe('Zoë Élodie')
    expect(titleCaseName('')).toBe('')
    expect(titleCaseName(null)).toBe('')
    expect(titleCaseName(undefined)).toBe('')
  })

  it('leaves the stand-in greeting word alone once capitalised', () => {
    expect(titleCaseName('there')).toBe('There')
  })
})

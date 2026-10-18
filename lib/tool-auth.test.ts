import { describe, expect, it } from 'vitest'
import { bearerToken, tokensMatch } from './tool-auth'

describe('bearerToken', () => {
  it('reads a bearer header and nothing else', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123')
    expect(bearerToken('bearer abc123')).toBe('abc123')
    expect(bearerToken('Basic abc123')).toBeNull()
    expect(bearerToken(null)).toBeNull()
  })
})

describe('tokensMatch', () => {
  it('matches only identical tokens', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abd')).toBe(false)
    expect(tokensMatch('abc', 'abcd')).toBe(false)
  })
  it('never matches when either side is missing', () => {
    expect(tokensMatch(null, 'abc')).toBe(false)
    expect(tokensMatch('abc', null)).toBe(false)
    expect(tokensMatch(null, null)).toBe(false)
  })
})

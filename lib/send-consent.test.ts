import { describe, expect, it } from 'vitest'
import { callerAgreement, notAgreedResult } from './send-consent'

describe('callerAgreement', () => {
  it('takes the words the caller said yes with', () => {
    expect(callerAgreement('  yes please, email it  ')).toBe('yes please, email it')
  })
  it('has nothing to go on when the field is missing or blank', () => {
    expect(callerAgreement(undefined)).toBeNull()
    expect(callerAgreement('   ')).toBeNull()
  })
  it('does not count punctuation as an answer', () => {
    expect(callerAgreement('?')).toBeNull()
    expect(callerAgreement('...')).toBeNull()
  })
  it('accepts a short yes', () => {
    expect(callerAgreement('ok')).toBe('ok')
  })
})

describe('notAgreedResult', () => {
  it('says nothing was sent and to ask first', () => {
    const result = notAgreedResult('the link to their order page')
    expect(result.ok).toBe(false)
    expect(result.sent).toBe(false)
    expect(String(result.message)).toContain('Nothing has been sent')
    expect(String(result.message)).toContain('the link to their order page')
  })
})

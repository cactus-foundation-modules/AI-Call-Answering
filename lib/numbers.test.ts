import { describe, expect, it } from 'vitest'
import { shouldAnswer } from './numbers'

describe('shouldAnswer', () => {
  const ringing = { open: true, wouldForward: true }
  it('never answers a number it has not been given', () => {
    expect(shouldAnswer(null, ringing)).toBe(false)
    expect(shouldAnswer({ enabled: false, mode: 'always' }, ringing)).toBe(false)
  })
  it('always mode answers whatever the number would do', () => {
    expect(shouldAnswer({ enabled: true, mode: 'always' }, ringing)).toBe(true)
  })
  it('when_unattended steps aside while a phone would ring', () => {
    expect(shouldAnswer({ enabled: true, mode: 'when_unattended' }, ringing)).toBe(false)
  })
  it('when_unattended answers out of hours or when nothing would ring', () => {
    expect(shouldAnswer({ enabled: true, mode: 'when_unattended' }, { open: false, wouldForward: false })).toBe(true)
    expect(shouldAnswer({ enabled: true, mode: 'when_unattended' }, { open: true, wouldForward: false })).toBe(true)
  })
})

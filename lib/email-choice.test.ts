import { describe, expect, it } from 'vitest'
import { askWhichEmailMessage, chooseOrderEmail } from './email-choice'

describe('chooseOrderEmail', () => {
  it('uses the only address on file', () => {
    expect(chooseOrderEmail(['Jo@Example.com', 'jo@example.com'], null)).toEqual({ kind: 'use', email: 'Jo@Example.com' })
  })
  it('asks when there are several and none was chosen', () => {
    expect(chooseOrderEmail(['a@example.com', 'b@example.com'], null)).toEqual({ kind: 'ask', emails: ['a@example.com', 'b@example.com'] })
  })
  it('accepts a choice from the list, ignoring case', () => {
    expect(chooseOrderEmail(['a@example.com', 'b@example.com'], 'B@Example.com')).toEqual({ kind: 'use', email: 'b@example.com' })
  })
  it('refuses an address that is not on file', () => {
    expect(chooseOrderEmail(['a@example.com'], 'evil@example.com')).toEqual({ kind: 'ask', emails: ['a@example.com'] })
  })
  it('reports none when no order has an address', () => {
    expect(chooseOrderEmail(['  '], null)).toEqual({ kind: 'none' })
  })
  it('tells the assistant to read, not spell', () => {
    expect(askWhichEmailMessage(['a@example.com', 'b@example.com'])).toContain('without spelling')
  })
})

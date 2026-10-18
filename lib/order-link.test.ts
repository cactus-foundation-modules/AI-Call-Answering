import { describe, expect, it } from 'vitest'
import { pickOrderForLink } from './order-link'

describe('pickOrderForLink', () => {
  it('sends the only verified order when none is named', () => {
    expect(pickOrderForLink(['DW000231'], null)).toBe('DW000231')
  })
  it('will not guess between several verified orders', () => {
    expect(pickOrderForLink(['DW000231', 'DW000232'], null)).toBeNull()
  })
  it('matches a spoken order number loosely', () => {
    expect(pickOrderForLink(['DW000231', 'DW000232'], 'dw 000232')).toBe('DW000232')
  })
  it('refuses an order the caller did not verify', () => {
    expect(pickOrderForLink(['DW000231'], 'DW000999')).toBeNull()
  })
})

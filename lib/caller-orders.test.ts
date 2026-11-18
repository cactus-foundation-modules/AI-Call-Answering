import { describe, expect, it } from 'vitest'
import { callerOrdersMissMessage, callerOrdersNote, pickOrderOnNumber } from './caller-orders'

// The test call that found this: the caller said "order two nine zero", the
// phone number also carried order 168, and the assistant asked about 168.
const onNumber = [
  { id: 'o-301', order_number: 'DW000301' },
  { id: 'o-290', order_number: 'DW000290' },
  { id: 'o-168', order_number: 'DW000168' },
]

describe('pickOrderOnNumber', () => {
  it('returns only the order the caller named, however they said it', () => {
    expect(pickOrderOnNumber(onNumber, '290')).toEqual(['o-290'])
    expect(pickOrderOnNumber(onNumber, 'DW 000290')).toEqual(['o-290'])
    expect(pickOrderOnNumber(onNumber, 'order number 0290')).toEqual(['o-290'])
  })
  it('returns nothing - not the other orders - when the named one is not on the number', () => {
    expect(pickOrderOnNumber(onNumber, '291')).toEqual([])
    expect(pickOrderOnNumber(onNumber, 'XY290')).toEqual([])
    expect(pickOrderOnNumber([], '290')).toEqual([])
  })
})

describe('callerOrdersNote', () => {
  it('with an order number: that order only, verified, never the others', () => {
    const note = callerOrdersNote({ orderNumber: '290', orderCount: 1, contactOnFile: true })
    expect(note).toContain('order 290')
    expect(note).toContain('do NOT ask for a postcode')
    expect(note).toContain('Talk about this order only')
    expect(note).toContain('Never mention, list or hint at any other order')
  })
  it('without one: the list is for matching what the caller described, never for reading out', () => {
    const note = callerOrdersNote({ orderNumber: null, orderCount: 3, contactOnFile: false })
    expect(note).toContain('MATCHING ONLY')
    expect(note).toContain('Do not read them out')
    expect(note).toContain('do not say how many there are')
    expect(note).toContain('Never mention, list or hint at any other order')
    expect(note).not.toContain('Assume they mean the first one')
  })
  it('a single order on the number is still not volunteered', () => {
    const note = callerOrdersNote({ orderNumber: null, orderCount: 1, contactOnFile: true })
    expect(note).toContain('only if it fits what the caller described')
    expect(note).not.toContain('Go straight to it')
  })
})

describe('callerOrdersMissMessage', () => {
  it('sends a named order not on this number to the postcode check, saying nothing of the rest', () => {
    const message = callerOrdersMissMessage('290')
    expect(message).toContain('lookup_order')
    expect(message).toContain('delivery postcode')
    expect(message).toContain('nothing about any other order')
  })
  it('keeps the old wording when no number was given', () => {
    expect(callerOrdersMissMessage(null)).toContain('No order is linked to the number')
  })
})

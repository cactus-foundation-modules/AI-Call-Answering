import { describe, expect, it } from 'vitest'
import { matchService, serviceMissMessage, type ServiceOption } from './delivery-choice'

const CHAIR: ServiceOption[] = [
  { key: 'flat-pack', label: 'Flat-packed', alsoKnownAs: 'Flat-packed by Fri 27 Nov (free)' },
  { key: 'pre-assembled', label: 'Pre-assembled', alsoKnownAs: 'Pre-assembled by Fri 27 Nov (£25.00 + VAT)' },
]
const DESK: ServiceOption[] = [
  { key: 'standard', label: 'Standard delivery' },
  { key: 'installed', label: 'Delivered and installed' },
]

describe('matchService', () => {
  it('takes an exact name or key', () => {
    expect(matchService('Pre-assembled', CHAIR)).toEqual({ kind: 'match', option: CHAIR[1] })
    expect(matchService('flat-pack', CHAIR)).toEqual({ kind: 'match', option: CHAIR[0] })
  })
  it('matches the words a caller uses for a service', () => {
    expect(matchService('pre-assembled delivery', CHAIR)).toMatchObject({ kind: 'match', option: { key: 'pre-assembled' } })
    expect(matchService('installation', DESK)).toMatchObject({ kind: 'match', option: { key: 'installed' } })
    expect(matchService('standard', DESK)).toMatchObject({ kind: 'match', option: { key: 'standard' } })
  })
  it('says when nothing or several fit', () => {
    expect(matchService('express', DESK)).toEqual({ kind: 'none', labels: ['Standard delivery', 'Delivered and installed'] })
    expect(matchService('delivery', DESK).kind).toBe('none')
    expect(matchService('by Fri 27 Nov', CHAIR).kind).toBe('ambiguous')
  })
})

describe('serviceMissMessage', () => {
  it('names the item and what is on offer', () => {
    expect(serviceMissMessage('Air Lite desk', 'express', { kind: 'none', labels: ['Standard', 'Installed'] })).toContain('Standard, Installed')
    expect(serviceMissMessage('Pedestal', 'installed', null)).toContain('no delivery choice')
  })
})

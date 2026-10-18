import { describe, expect, it } from 'vitest'
import { describeDeliveryMoment, describeDeliveryTiming, describeParcels, summariseParcels } from './delivery-words'
import { newConsignmentParcel } from '@/modules/shop/lib/consignment-parcels'

const LONDON = 'Europe/London'

function box(number: string, deliveredAt: string | null, receivedBy: string | null = null) {
  return { ...newConsignmentParcel(`code-${number}`, number), delivered: deliveredAt !== null, deliveredAt, receivedBy }
}

describe('describeDeliveryMoment', () => {
  it('speaks the day and clock time in the shop time zone', () => {
    expect(describeDeliveryMoment('2026-10-16T19:29:15.039Z', LONDON)).toBe('Friday 16 October at 8:29 pm')
  })
  it('crosses midnight with the zone, not UTC', () => {
    expect(describeDeliveryMoment('2026-06-30T23:30:00Z', LONDON)).toBe('Wednesday 1 July at 12:30 am')
  })
  it('gives nothing for a bad instant', () => {
    expect(describeDeliveryMoment('not a date', LONDON)).toBeNull()
  })
})

describe('summariseParcels', () => {
  it('keeps the days apart when a split delivery landed on two', () => {
    const parcels = describeParcels([
      box('1', '2026-10-16T19:29:15.039Z', 'LEE'),
      box('2', '2026-10-16T19:29:15.039Z'),
      box('3', '2026-10-16T19:29:15.039Z'),
      box('4', '2026-10-17T08:26:00.000Z', 'THOMPSON'),
    ], LONDON)
    expect(parcels[0]?.signedForBy).toBe('Lee')
    expect(summariseParcels(parcels)).toBe(
      'Three parcels were delivered on Friday 16 October at 8:29 pm. One parcel was delivered on Saturday 17 October at 9:26 am.',
    )
  })
  it('says together only when they truly were', () => {
    const parcels = describeParcels([box('1', '2026-10-16T19:29:00Z'), box('2', '2026-10-16T19:29:00Z')], LONDON)
    expect(summariseParcels(parcels)).toBe('All two parcels were delivered together on Friday 16 October at 8:29 pm.')
  })
  it('names the parcels still to come', () => {
    const parcels = describeParcels([box('1', '2026-10-16T19:29:00Z'), box('2', null), box('3', null)], LONDON)
    expect(summariseParcels(parcels)).toBe(
      'One of the three parcels was delivered on Friday 16 October at 8:29 pm. Two parcels are still to be delivered.',
    )
  })
})

describe('describeDeliveryTiming', () => {
  it('totals the working days', () => {
    expect(describeDeliveryTiming(1, 2)).toEqual({
      dispatch: 'dispatched within one working day',
      transit: 'two working days on the road after dispatch',
      totalWorkingDays: 3,
    })
  })
  it('handles same-day dispatch', () => {
    expect(describeDeliveryTiming(0, 1).dispatch).toContain('same working day')
  })
})

import { describe, expect, it } from 'vitest'
import { arrivesInTime, neededByDate } from './needed-by'

// Wednesday the 25th of November 2026.
const TODAY = '2026-11-25'

describe('neededByDate', () => {
  it('reads a weekday as the next one, today counting', () => {
    expect(neededByDate('wednesday', TODAY)).toBe('2026-11-25')
    expect(neededByDate('by next Tuesday please', TODAY)).toBe('2026-12-01')
    expect(neededByDate('friday', TODAY)).toBe('2026-11-27')
  })

  it('reads today, tomorrow, dates and days of the month', () => {
    expect(neededByDate('tomorrow', TODAY)).toBe('2026-11-26')
    expect(neededByDate('2026-12-04', TODAY)).toBe('2026-12-04')
    expect(neededByDate('the 2nd', TODAY)).toBe('2026-12-02')
    expect(neededByDate('30th', TODAY)).toBe('2026-11-30')
    expect(neededByDate('3 December', TODAY)).toBe('2026-12-03')
    expect(neededByDate('January 5th', TODAY)).toBe('2027-01-05')
    expect(neededByDate('soon', TODAY)).toBeNull()
  })
})

describe('arrivesInTime (the live-site Tuesday before Wednesday)', () => {
  it('a Tuesday delivery is in time for a Wednesday deadline', () => {
    expect(arrivesInTime('2026-12-01', neededByDate('wednesday', '2026-11-26') ?? '')).toBe(true)
    expect(arrivesInTime('2026-12-07', '2026-12-02')).toBe(false)
    expect(arrivesInTime('2026-12-02', '2026-12-02')).toBe(true)
  })
})

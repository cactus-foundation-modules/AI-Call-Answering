import { describe, expect, it } from 'vitest'
import { lineChoices } from './order-detail'

describe('lineChoices delivery estimate', () => {
  const meta = { fields: [{ label: 'Colour', value: 'Beech' }, { label: 'Delivery', value: 'Flat-Pack - by Tuesday 27th of October' }] }
  it('keeps the checkout delivery line by default', () => {
    expect(lineChoices(meta)).toEqual(['Colour: Beech', 'Delivery: Flat-Pack - by Tuesday 27th of October'])
  })
  it('drops it once the courier has given a date', () => {
    expect(lineChoices(meta, { dropDeliveryEstimate: true })).toEqual(['Colour: Beech'])
  })
})
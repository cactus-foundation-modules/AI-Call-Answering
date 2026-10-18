import { describe, expect, it } from 'vitest'
import { describeForecast, describeScope, readForecast, type DeliveryForecast } from './delivery-forecast'

const colours = { all: false, count: 3, appliesTo: [{ option: 'Colour', values: ['Blue', 'Black', 'Red'] }], combinations: null }
const rest = { all: false, count: 5, appliesTo: [{ option: 'Colour', values: ['Green', 'Grey'] }], combinations: null }

const forecast: DeliveryForecast = {
  productId: 'p1',
  today: '2026-10-18',
  hasVariations: true,
  services: [
    {
      key: 'express', label: 'Express', description: null, notOfferedOn: null,
      groups: [
        { ...colours, date: '2026-10-20', dateLabel: 'Tuesday 20th of October', price: 10 },
        { ...rest, date: '2026-10-21', dateLabel: 'Wednesday 21st of October', price: 10 },
      ],
    },
    {
      key: 'standard', label: 'Standard', description: 'Kerbside', notOfferedOn: null,
      groups: [{ all: true, count: 8, appliesTo: null, combinations: null, date: '2026-10-23', dateLabel: 'Friday 23rd of October', price: 0 }],
    },
  ],
}

describe('describeForecast', () => {
  it('says which options arrive first and what the rest get', () => {
    const [express] = describeForecast(forecast, '£', 'EXCLUSIVE')
    expect(express!.options).toEqual([
      'Blue, Black or Red: £10 excluding VAT, delivered by Tuesday 20th of October',
      'Green or Grey: £10 excluding VAT, delivered by Wednesday 21st of October',
    ])
  })

  it('reads one short line when every option shares a date and price', () => {
    const standard = describeForecast(forecast, '£', 'EXCLUSIVE')[1]!
    expect(standard.options).toEqual(['free, delivered by Friday 23rd of October'])
    expect(standard.note).toBe('Kerbside')
  })

  it('says plainly that an option is out of stock when it has no date', () => {
    const odd: DeliveryForecast = {
      ...forecast,
      services: [{ ...forecast.services[0]!, groups: [{ ...colours, date: null, dateLabel: null, price: 10 }] }],
    }
    expect(describeForecast(odd, '£', 'EXCLUSIVE')[0]!.options[0]).toContain('out of stock')
  })

  it('names the options that cannot have a service', () => {
    const limited: DeliveryForecast = { ...forecast, services: [{ ...forecast.services[0]!, notOfferedOn: rest }] }
    expect(describeForecast(limited, '£', 'EXCLUSIVE')[0]!.notAvailableOn).toBe('Green or Grey')
  })
})

describe('describeScope', () => {
  it('lists combinations with a count of the rest', () => {
    expect(describeScope({ all: false, count: 14, appliesTo: null, combinations: ['Blue / 160cm', 'Red / 180cm'] }))
      .toBe('Blue / 160cm, Red / 180cm and 12 more')
  })
})

describe('readForecast', () => {
  it('survives a drifted shape', () => {
    expect(readForecast(null)).toBeNull()
    expect(readForecast({ productId: 'x', services: [{ label: 1 }] })?.services).toEqual([])
    expect(readForecast(JSON.parse(JSON.stringify(forecast)))?.services).toHaveLength(2)
  })
})

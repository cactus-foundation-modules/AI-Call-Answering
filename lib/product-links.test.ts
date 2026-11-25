import { describe, expect, it } from 'vitest'
import { DELIVERY_PARAM, withDeliveryParam } from './product-links'

// A product address carrying the delivery service chosen for it, the way Live
// Chat and the unified inbox read it.

describe('withDeliveryParam', () => {
  it('adds the service to a plain address and to a variation\'s, keeping its options', () => {
    expect(withDeliveryParam('https://shop.test/shop/products/oslo-air-piste', 'express'))
      .toBe('https://shop.test/shop/products/oslo-air-piste?delivery-service=express')
    expect(withDeliveryParam('https://shop.test/oslo-air-piste?width=140cm&frame-colour=white', 'express'))
      .toBe('https://shop.test/oslo-air-piste?width=140cm&frame-colour=white&delivery-service=express')
  })

  it('replaces an earlier choice rather than adding a second', () => {
    const once = withDeliveryParam('https://shop.test/desk', 'express')
    const url = new URL(withDeliveryParam(once, 'installed') ?? '')
    expect(url.searchParams.getAll(DELIVERY_PARAM)).toEqual(['installed'])
  })

  it('leaves an address alone with no service, no address as none, and a broken one as it was', () => {
    expect(withDeliveryParam('https://shop.test/desk', null)).toBe('https://shop.test/desk')
    expect(withDeliveryParam(null, 'express')).toBeNull()
    expect(withDeliveryParam('not an address', 'express')).toBe('not an address')
  })
})

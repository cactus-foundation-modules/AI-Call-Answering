import { describe, expect, it } from 'vitest'
import { readLines, requestedServices } from './phone-basket'
import { withDeliveries } from './call-email'
import type { CallBasket } from './phone-basket'

describe('phone basket lines with a delivery service', () => {
  it('keeps meta and the service name, drops junk', () => {
    expect(readLines([
      { productId: 'a', quantity: 2, meta: { shippingTier: 'installed' }, delivery: 'Installed' },
      { productId: 'b', quantity: 1, meta: { bad: { nested: true } }, delivery: 'Ignored' },
    ])).toEqual([
      { productId: 'a', quantity: 2, meta: { shippingTier: 'installed' }, delivery: 'Installed' },
      { productId: 'b', quantity: 1 },
    ])
  })
  it('takes the first service named for each product', () => {
    const asked = requestedServices([
      { product_id: 'a', quantity: 1, delivery: 'installed' },
      { product_id: 'a', quantity: 1, delivery: 'standard' },
      { product_id: 'b', quantity: 1 },
    ])
    expect([...asked]).toEqual([['a', 'installed']])
  })
})

describe('withDeliveries', () => {
  const menus = new Map([['a', [{ key: 'standard', label: 'Standard' }, { key: 'installed', label: 'Installed' }]]])
  const ref = { moduleName: 'shop', kind: 'variation' as const, id: 'a' }
  const basket: CallBasket = {
    token: 't', quote: null, quotesSaved: 0,
    lines: [{ productId: 'a', quantity: 10, meta: { shippingTier: 'installed' }, delivery: 'Installed' }],
  }
  it('uses a service named on the email', () => {
    expect(withDeliveries([ref], [{ productId: 'a', service: 'standard' }], null, menus)).toEqual([{ ...ref, delivery: 'standard' }])
  })
  it('falls back to the basket line', () => {
    expect(withDeliveries([ref], [], basket, menus)).toEqual([{ ...ref, delivery: 'installed' }])
  })
  it('leaves a product with no services alone', () => {
    expect(withDeliveries([{ ...ref, id: 'z' }], [{ productId: 'z', service: 'x' }], basket, menus)).toEqual([{ ...ref, id: 'z' }])
  })
})

import { getShopConfigCached } from '@/modules/shop/lib/config'
import { decideShippingZone, listShippingZones } from '@/modules/shop/lib/db/tax-shipping'
import { excludedPostcodeMessage } from '@/modules/shop/lib/excluded-postcode'
import { normalisePostcode } from '@/modules/shop/lib/postcode-patterns'
import { describeForecast, loadDeliveryForecast, type SpokenDeliveryService } from './delivery-forecast'

// ---------------------------------------------------------------------------
// "Can you get it to Inverness by Friday?"
//
// Two questions in one. Whether the shop delivers to that postcode at all is
// the checkout's own rule - the same zones and carve-outs (Highlands, islands,
// Northern Ireland and the like) that would turn the order away at the address
// step - so the caller hears it now rather than after building a basket. When
// it does, the dates are the product's own delivery forecast, worked out option
// by option, service by service, from the shipping module's lead times, cut-off
// and holidays: the same dates the product page shows.
// ---------------------------------------------------------------------------

const POSTCODE_SHAPE = /^[A-Z]{1,2}[0-9][A-Z0-9]?([0-9][A-Z]{2})?$/

export type PostcodeDelivery =
  | { ok: false; message: string }
  | {
      ok: true
      delivers: boolean
      /** The shop's own words for a postcode it cannot deliver to. */
      refusal: string | null
      services: SpokenDeliveryService[] | null
      note: string
    }

export async function deliveryToPostcode(rawPostcode: string, productId: string | null): Promise<PostcodeDelivery> {
  const postcode = normalisePostcode(rawPostcode)
  if (!POSTCODE_SHAPE.test(postcode)) {
    return { ok: false, message: 'That does not sound like a whole UK postcode. Ask them to say it again one character at a time. The first half on its own (for example IV2) is enough.' }
  }
  const [zones, config] = await Promise.all([listShippingZones(), getShopConfigCached()])
  const decision = decideShippingZone(zones, postcode)
  if (decision.excluded || decision.uncovered) {
    return {
      ok: true,
      delivers: false,
      refusal: excludedPostcodeMessage(config.excludedPostcodeMessage),
      services: null,
      note: 'The shop does not deliver to this postcode: the checkout would turn the order away. Say so kindly, in the shop\'s own words above, and offer to take a message if they would like the team to look into it. Do not suggest a way round it.',
    }
  }
  if (!productId) {
    return {
      ok: true,
      delivers: true,
      refusal: null,
      services: null,
      note: 'The shop delivers to this postcode. For a date, call this again with the product (or the variation they want).',
    }
  }
  const forecast = await loadDeliveryForecast(productId)
  const services = forecast ? describeForecast(forecast, config.currencySymbol, config.taxMode) : null
  return {
    ok: true,
    delivers: true,
    refusal: null,
    services,
    note: services && services.length > 0
      ? 'The shop delivers to this postcode, and these dates hold for it. To answer "by Friday?", compare the date for the option they want with the day they named and say yes or no plainly, with the date. If only a faster service makes it, say which and what it costs.'
      : 'The shop delivers to this postcode, but there is no delivery date for this product to give. Say you cannot see a date from here and offer to take a message.',
  }
}

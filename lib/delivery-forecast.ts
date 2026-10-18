import { formatPrice, priceBasis } from './product-format'

// ---------------------------------------------------------------------------
// Delivery for a product with variations, said the way a person on the phone
// would say it.
//
// A listing's delivery depends on WHICH variation is bought: the blue, black and
// red may be there by Tuesday for £10 while the other colours are Wednesday week.
// The shop's own product page tells a shopper the answer for the variation they
// have picked; a caller has not picked one, so the assistant is given the whole
// picture - every service, with the dates and prices of the groups of
// variations - and a sentence per group to read from.
//
// The figures come from whichever module publishes `shop.product-delivery-
// forecast` (advanced shipping, on a shop that has it), looked up through the
// registry rather than imported: this module must build on a shop without it.
// Nothing is estimated here. Dates are the module's own, worked out at the
// moment of the call against the shop's calendar.
// ---------------------------------------------------------------------------

const POINT = 'shop.product-delivery-forecast'

type ForecastProvider = (productIds: string[]) => Promise<Map<string, unknown>>

export type ForecastScope = {
  all: boolean
  appliesTo: Array<{ option: string; values: string[] }> | null
  combinations: string[] | null
  count: number
}

export type ForecastGroup = ForecastScope & {
  date: string | null
  dateLabel: string | null
  price: number
}

export type ForecastService = {
  key: string
  label: string
  description: string | null
  groups: ForecastGroup[]
  notOfferedOn: ForecastScope | null
}

export type DeliveryForecast = {
  productId: string
  today: string
  hasVariations: boolean
  services: ForecastService[]
}

/** One service, ready to read out. */
export type SpokenDeliveryService = {
  service: string
  note: string | null
  /** One sentence per group of variations, soonest first. */
  options: string[]
  /** Which variations cannot have this service, when some cannot. */
  notAvailableOn: string | null
}

function readScope(row: Record<string, unknown>): ForecastScope | null {
  const count = row.count
  if (typeof row.all !== 'boolean' || typeof count !== 'number') return null
  const appliesTo = Array.isArray(row.appliesTo)
    ? row.appliesTo.flatMap((entry: unknown) => {
        const e = entry as Record<string, unknown> | null
        return e && typeof e.option === 'string' && Array.isArray(e.values)
          ? [{ option: e.option, values: e.values.filter((v): v is string => typeof v === 'string') }]
          : []
      })
    : null
  const combinations = Array.isArray(row.combinations)
    ? row.combinations.filter((c): c is string => typeof c === 'string')
    : null
  return {
    all: row.all,
    count,
    appliesTo: appliesTo && appliesTo.length > 0 ? appliesTo : null,
    combinations: combinations && combinations.length > 0 ? combinations : null,
  }
}

/** Checked rather than trusted: it crosses a registry seam with no shared types,
 *  so a shape that has drifted costs the call one answer, not the call. */
export function readForecast(value: unknown): DeliveryForecast | null {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.productId !== 'string' || !Array.isArray(row.services)) return null
  const services: ForecastService[] = []
  for (const entry of row.services as unknown[]) {
    const s = entry as Record<string, unknown> | null
    if (!s || typeof s.label !== 'string' || typeof s.key !== 'string' || !Array.isArray(s.groups)) continue
    const groups: ForecastGroup[] = []
    for (const g of s.groups as unknown[]) {
      const group = g as Record<string, unknown> | null
      if (!group || typeof group.price !== 'number' || !Number.isFinite(group.price)) continue
      const scope = readScope(group)
      if (!scope) continue
      groups.push({
        ...scope,
        price: group.price,
        date: typeof group.date === 'string' ? group.date : null,
        dateLabel: typeof group.dateLabel === 'string' ? group.dateLabel : null,
      })
    }
    if (groups.length === 0) continue
    const notOffered = s.notOfferedOn && typeof s.notOfferedOn === 'object'
      ? readScope(s.notOfferedOn as Record<string, unknown>)
      : null
    services.push({
      key: s.key,
      label: s.label,
      description: typeof s.description === 'string' && s.description.trim() ? s.description.trim() : null,
      groups,
      notOfferedOn: notOffered,
    })
  }
  return {
    productId: row.productId,
    today: typeof row.today === 'string' ? row.today : '',
    hasVariations: row.hasVariations === true,
    services,
  }
}

/** The forecast for one product, or null when the shop has no such module, will
 *  not deliver the product, or the module fell over. */
export async function loadDeliveryForecast(productId: string): Promise<DeliveryForecast | null> {
  // Dynamic on purpose, as in shop's own detail-delivery: a static edge to the
  // generated registry closes an import cycle (scripts/check-import-cycles.mjs).
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  const registered: Record<string, unknown> = moduleServerExtensionPointComponents[POINT] ?? {}
  const provider = Object.values(registered).find((e): e is ForecastProvider => typeof e === 'function')
  if (!provider) return null
  try {
    const answered = await provider([productId])
    return answered instanceof Map ? readForecast(answered.get(productId)) : null
  } catch (error) {
    console.error(`[ai-call-answering] delivery forecast failed for product ${productId}:`, error)
    return null
  }
}

function joinOr(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

/** "Blue, Black or Red", "160cm in Oak", "Blue / 160cm, Red / 180cm". */
export function describeScope(scope: ForecastScope): string {
  if (scope.all) return 'every option'
  if (scope.appliesTo) return scope.appliesTo.map((a) => joinOr(a.values)).join(' in ')
  if (scope.combinations) {
    const extra = scope.count - scope.combinations.length
    return `${scope.combinations.join(', ')}${extra > 0 ? ` and ${extra} more` : ''}`
  }
  return `${scope.count} of the options`
}

function describeGroup(group: ForecastGroup, symbol: string, basis: string, single: boolean): string {
  const price = group.price === 0 ? 'free' : `${formatPrice(group.price, symbol)} ${basis}`
  const when = group.dateLabel ? `delivered by ${group.dateLabel}` : 'no delivery date can be promised right now'
  return single ? `${price}, ${when}` : `${describeScope(group)}: ${price}, ${when}`
}

/** What the assistant is given for a product's delivery. When every option
 *  shares one date and price it is one short line; when they differ, one line per
 *  group, so the caller can be told which colours get there first. */
export function describeForecast(forecast: DeliveryForecast, symbol: string, taxMode: string): SpokenDeliveryService[] {
  const basis = priceBasis(taxMode)
  return forecast.services.map((service) => ({
    service: service.label,
    note: service.description,
    options: service.groups.map((group) => describeGroup(group, symbol, basis, service.groups.length === 1 && group.all)),
    notAvailableOn: service.notOfferedOn ? describeScope(service.notOfferedOn) : null,
  }))
}

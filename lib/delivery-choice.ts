import { resolveCartLines } from '@/modules/shop/lib/checkout'

// ---------------------------------------------------------------------------
// The delivery service a caller chose ("pre-assembled", "installed"), carried
// into the basket, the quote and the summary email instead of left for them to
// pick again at checkout.
//
// Two doors, neither of them another module's code:
//
//   - The BASKET is asked through shop's own cart-line resolution. A module that
//     prices a per-line service (advanced shipping today) answers each line with
//     a `control`: the meta field it reads (`key`) and the services on offer
//     (`options`, value = the service's key). Writing `meta[control.key] = value`
//     is exactly what the basket page does when a shopper picks one, so the
//     link, a quote saved from it and checkout all see the caller's choice -
//     and nothing here knows what the field is called.
//   - The EMAIL is asked through `shop.product-delivery-timing`, the point the
//     unified inbox reads to print a delivery line under a product. Its keys are
//     what the inbox's product reference carries.
//
// The model names a service in its own words, taken from get_product. Matching
// those words to one service is pure (matchService) and pinned by tests.
// ---------------------------------------------------------------------------

/** One service a line or product can have: its key, and the words to match on. */
export type ServiceOption = { key: string; label: string; alsoKnownAs?: string }

export type ServiceMatch =
  | { kind: 'match'; option: ServiceOption }
  | { kind: 'ambiguous'; labels: string[] }
  | { kind: 'none'; labels: string[] }

/** Words that say nothing about WHICH service: "the installation option". */
const SERVICE_FILLER = new Set(['delivery', 'delivered', 'service', 'option', 'the', 'a', 'an', 'with', 'please', 'one', 'and'])

function words(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((word) => word !== '' && !SERVICE_FILLER.has(word))
}

/** A word and its obvious relatives: "installed" and "installation" both say
 *  "install", "assembled" and "assembly" both say "assembl". */
function stem(word: string): string {
  return word.replace(/(ation|ations|ed|ing|s|y)$/, '') || word
}

function stems(value: string): Set<string> {
  return new Set(words(value).map(stem))
}

/**
 * Which one service a caller's words name. Exact key or name first; then the
 * only service whose name holds every word said ("pre-assembled" in
 * "Pre-assembled delivery"); then the only one sharing any word. Pure.
 */
export function matchService(spoken: string, options: readonly ServiceOption[]): ServiceMatch {
  const labels = options.map((option) => option.label)
  const said = spoken.trim().toLowerCase()
  if (!said || options.length === 0) return { kind: 'none', labels }
  const exact = options.find((option) => option.key.toLowerCase() === said || option.label.toLowerCase() === said)
  if (exact) return { kind: 'match', option: exact }

  const wanted = [...stems(spoken)]
  if (wanted.length === 0) return { kind: 'none', labels }
  const haystack = (option: ServiceOption) => stems(`${option.label} ${option.key} ${option.alsoKnownAs ?? ''}`)
  const pick = (fits: ServiceOption[]): ServiceMatch | null => {
    if (fits.length === 1) return { kind: 'match', option: fits[0]! }
    if (fits.length > 1) return { kind: 'ambiguous', labels: fits.map((option) => option.label) }
    return null
  }
  const full = options.filter((option) => {
    const hay = haystack(option)
    return wanted.every((word) => hay.has(word))
  })
  const fullAnswer = pick(full)
  if (fullAnswer) return fullAnswer
  const some = options.filter((option) => {
    const hay = haystack(option)
    return wanted.some((word) => hay.has(word))
  })
  return pick(some) ?? { kind: 'none', labels }
}

type CartLines = Parameters<typeof resolveCartLines>[0]

/** The per-line picker the shop offers each product, by product id: the meta
 *  field to write and the services on offer. A product with no picker is absent;
 *  so is everything if the basket cannot be worked out just now. */
export async function basketServiceMenus(
  productIds: readonly string[],
): Promise<Map<string, { field: string; options: ServiceOption[] }>> {
  const out = new Map<string, { field: string; options: ServiceOption[] }>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return out
  try {
    const cart: CartLines = ids.map((productId) => ({ productId, quantity: 1 }))
    const [resolved, names] = await Promise.all([resolveCartLines(cart), timingMenus(ids)])
    for (const line of resolved) {
      const control = line.control
      if (!control || !control.key || !Array.isArray(control.options) || control.options.length === 0) continue
      const plain = new Map((names.get(line.product.id) ?? []).map((option) => [option.key, option.label]))
      out.set(line.product.id, {
        field: control.key,
        options: control.options.map((option) => ({
          key: option.value,
          // The plain name ("Pre-assembled") where the timing point gives one;
          // the basket's own wording carries a date and a price, which make a
          // poor thing to match a spoken name against.
          label: plain.get(option.value) ?? option.label,
          alsoKnownAs: option.label,
        })),
      })
    }
  } catch (error) {
    console.error('[ai-call-answering] could not read the basket delivery services:', error)
  }
  return out
}

type TimingProvider = (productIds: string[]) => Promise<Map<string, unknown>>

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/

/** The services each product is offered, from `shop.product-delivery-timing`,
 *  by product id. Checked field by field: the shape crosses a registry seam. */
export async function timingMenus(productIds: readonly string[]): Promise<Map<string, ServiceOption[]>> {
  const out = new Map<string, ServiceOption[]>()
  const ids = [...new Set(productIds)].filter(Boolean)
  if (ids.length === 0) return out
  try {
    const { modulePublicExtensionPointComponents } = await import('@/lib/modules/extension-points.public')
    const registered: Record<string, unknown> = modulePublicExtensionPointComponents['shop.product-delivery-timing'] ?? {}
    const provider = Object.values(registered).find((entry): entry is TimingProvider => typeof entry === 'function')
    if (!provider) return out
    const answered = await provider(ids)
    if (!(answered instanceof Map)) return out
    for (const [productId, value] of answered) {
      if (typeof productId !== 'string' || typeof value !== 'object' || value === null) continue
      const list = (value as Record<string, unknown>).options
      const options = (Array.isArray(list) ? list : []).flatMap((entry: unknown): ServiceOption[] => {
        const row = entry as Record<string, unknown> | null
        const key = typeof row?.key === 'string' ? row.key.trim() : ''
        const label = typeof row?.label === 'string' ? row.label.trim() : ''
        return KEY_PATTERN.test(key) && label ? [{ key, label }] : []
      })
      if (options.length > 0) out.set(productId, options)
    }
  } catch (error) {
    console.error('[ai-call-answering] could not read the delivery services:', error)
  }
  return out
}

/** What the model is told when a service could not be set, in words it can act on. */
export function serviceMissMessage(name: string, said: string, match: ServiceMatch | null): string {
  if (!match) return `${name}: the shop offers no delivery choice for this item, so "${said}" could not be set. Tell the caller the checkout shows its delivery.`
  if (match.kind === 'ambiguous') return `${name}: "${said}" could mean ${match.labels.join(' or ')}. Ask which, then call again with that name.`
  if (match.kind === 'match') return `${name}: set to ${match.option.label}.`
  return `${name}: "${said}" is not one of its delivery services (${match.labels.join(', ')}). Ask which they want, then call again with that name.`
}

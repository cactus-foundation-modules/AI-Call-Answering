// Copied from the chat assistant (modules/ai-agent-for-live-chat/lib/shop/) and kept in step
// by hand: the two modules never import each other. Learned on live chats; a
// caller asks the same questions.
import { getSiteUrlOrNull } from '@/lib/config/env'
import { productUrl, type ProductUrlStyle } from '@/modules/shop/lib/product-url'

// ---------------------------------------------------------------------------
// A product's own page address, for the model to put in a reply.
//
// Live Chat draws a product card for any product page address standing on its
// own line (modules/chat/lib/product-links.ts), and this module puts Add to
// basket under it. So every product the tools hand the model carries its full
// address, built here from the shop's own slug and URL style rather than
// written by the model. A variation's address names its options the way the
// storefront's own picker does (`?seat-colour=oxford-blue&width=1600mm`), which
// is how Live Chat works out the exact variation, so the card's Add to basket
// adds exactly what was recommended.
//
// Once the visitor has chosen a delivery service for a product, its address
// also carries `delivery-service=<key>` (withDeliveryParam), which Live Chat
// reads to draw that service, priced by the shop, on the card.
//
// The address is a site-relative path made absolute with the site's own URL.
// Without one (a site that has not set SITE_URL) there is no address to give,
// and the model is simply told the product's name.
// ---------------------------------------------------------------------------

export type PageBase = { siteUrl: string; style: ProductUrlStyle } | null

/** The query key an option goes by on the storefront: its name, lowercased,
 *  accents folded, runs of anything else hyphenated. Restated from the
 *  variations module (as Live Chat restates it), which this one does not
 *  import. Pure. */
export function optionParamKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** One option of a variation: [option name, value slug]. */
export type OptionPick = readonly [string, string]

/** The full address of a product page, with a variation's picks when there are
 *  any. Null without a site address or a slug. Pure. */
export function productPage(base: PageBase, slug: string | null | undefined, picks: readonly OptionPick[] = []): string | null {
  const clean = slug?.trim() ?? ''
  if (!base || !clean) return null
  const url = productUrl(base.siteUrl.replace(/\/+$/, ''), clean, base.style)
  const params = new URLSearchParams()
  for (const [name, value] of picks) {
    const key = optionParamKey(name)
    if (key && value && !params.has(key)) params.set(key, value)
  }
  const query = params.toString()
  return query ? `${url}?${query}` : url
}

/** The site's address and the shop's URL style, read once per lookup. */
export function pageBase(style: ProductUrlStyle): PageBase {
  const siteUrl = getSiteUrlOrNull()
  return siteUrl ? { siteUrl, style } : null
}

/** The query parameter a product address carries a chosen delivery service in.
 *  Restated from the unified inbox (lib/products/render.ts), which puts it on a
 *  product it sends with a delivery chosen, and which Live Chat reads to draw
 *  the delivery line on a product card (modules/chat/lib/products.ts). Neither
 *  is imported: the name is the contract. */
export const DELIVERY_PARAM = 'delivery-service'

/** A product address with the chosen delivery service on it, the variation's
 *  picks left exactly as they were. A null address stays null; one that does
 *  not parse is handed back as it was. Pure. */
export function withDeliveryParam(url: string | null, key: string | null | undefined): string | null {
  if (!url || !key) return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set(DELIVERY_PARAM, key)
    return parsed.toString()
  } catch {
    return url
  }
}

/** Reads a [name, slug] list as Postgres json_agg hands it back. Anything
 *  that is not a pair of strings is dropped. Pure. */
export function readPicks(value: unknown): OptionPick[] {
  if (!Array.isArray(value)) return []
  const out: OptionPick[] = []
  for (const entry of value) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') out.push([entry[0], entry[1]])
  }
  return out
}

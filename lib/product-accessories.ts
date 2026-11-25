import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { describePriceRange, effectivePrice, formatPrice } from './product-format'
import { productPage, type PageBase } from './product-links'
import { plainText, truncate } from './text'

// Copied from the phone assistant (modules/ai-call-answering/lib/product-accessories.ts) and
// kept in step by hand: the two modules never import each other. Adapted for
// a phone call: the url is there for a text or email, never to read out.
// ---------------------------------------------------------------------------
// The accessories a product is sold with, for the assistant to mention.
//
// On the website they are the "Accessories" box under a desk: a power module, a
// pedestal, a monitor arm, a floor mat. Each is a real product of its own, linked
// to the main listing by product-addons-for-shop. A caller has no box to look at,
// so unless the assistant is told what is there it cannot offer any of it, and a
// customer who would have bought the pedestal leaves without hearing it exists.
//
// Read straight from that module's table, never through its code - the same
// bargain this module strikes with shop-variations and product-attributes:
// installed, the query answers; absent, `to_regclass` says so first and the list
// is empty. Only links the module itself would show are returned (switched on,
// the accessory live and visible), and each one carries its own id so
// get_product can give its options and exact prices like any other product.
// ---------------------------------------------------------------------------

/** Enough to mention a handful without drowning the caller. */
export const MAX_ACCESSORIES = 12

export type Accessory = {
  /** The accessory's own product id: pass it to get_product for its options and
   *  exact price, and and its url, for a text or email (never read out). */
  productId: string
  name: string
  /** Its own page, for a text or email. */
  url: string | null
  /** "from £20 to £45" for one sold in variations, else its price. */
  price: string
  summary: string
  /** True when the shop offers it only with some of the main product's options
   *  (a frame colour, a size). */
  onlyWithSomeOptions: boolean
}

export type AccessoryList = {
  /** What the shop calls them on its pages ("Accessories"). */
  noun: string
  items: Accessory[]
}

type Row = {
  addon_id: string
  name: string
  slug: string | null
  short_description: string | null
  price: unknown
  sale_price: unknown
  low: unknown
  high: unknown
  variants: number | null
  config: unknown
  noun: string | null
}

async function exists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`
  return rows[0]?.present === true
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Whether a link's config limits the accessory to some of the main product's
 *  options. Read defensively: the shape belongs to another module. */
export function hasShowWhenRules(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false
  const rules = (config as Record<string, unknown>).showWhen
  return Array.isArray(rules) && rules.length > 0
}

/** The price to say for one accessory. Pure. */
export function accessoryPrice(row: Pick<Row, 'price' | 'sale_price' | 'low' | 'high' | 'variants'>, symbol: string): string {
  const low = toNumber(row.low)
  const high = toNumber(row.high)
  if ((row.variants ?? 0) > 0 && low !== null && high !== null) {
    return describePriceRange({ low, high }, symbol)
  }
  return formatPrice(effectivePrice(toNumber(row.price) ?? 0, toNumber(row.sale_price)).now, symbol)
}

/**
 * The accessories offered with a product. A variation's id is taken back to its
 * listing first, because links are made on the listing. Empty where the shop has
 * no accessories module or the product has none.
 */
export async function loadAccessories(productId: string, symbol: string, base: PageBase = null): Promise<AccessoryList | null> {
  if (!(await exists('pad_links'))) return null
  const variations = await exists('svr_variants')
  const listing = variations
    ? Prisma.sql`COALESCE((SELECT "product_id" FROM "svr_variants" WHERE "child_product_id" = ${productId} LIMIT 1), ${productId})`
    : Prisma.sql`${productId}`
  const spread = variations
    ? Prisma.sql`
        (SELECT MIN(COALESCE(NULLIF(c."sale_price", 0), c."price")) FROM "svr_variants" sv JOIN "shp_products" c ON c."id" = sv."child_product_id"
          WHERE sv."product_id" = a."id" AND sv."enabled" = true AND c."status" = 'ACTIVE') AS low,
        (SELECT MAX(COALESCE(NULLIF(c."sale_price", 0), c."price")) FROM "svr_variants" sv JOIN "shp_products" c ON c."id" = sv."child_product_id"
          WHERE sv."product_id" = a."id" AND sv."enabled" = true AND c."status" = 'ACTIVE') AS high,
        (SELECT COUNT(*)::int FROM "svr_variants" sv JOIN "shp_products" c ON c."id" = sv."child_product_id"
          WHERE sv."product_id" = a."id" AND sv."enabled" = true AND c."status" = 'ACTIVE') AS variants`
    : Prisma.sql`NULL::numeric AS low, NULL::numeric AS high, 0 AS variants`
  const noun = (await exists('pad_settings'))
    ? Prisma.sql`(SELECT "noun_plural" FROM "pad_settings" WHERE "id" = 'singleton')`
    : Prisma.sql`NULL::text`
  const rows = await prisma.$queryRaw<Row[]>(Prisma.sql`
    SELECT a."id" AS addon_id, a."name", a."slug", a."short_description", a."price", a."sale_price", l."config",
           ${spread}, ${noun} AS noun
    FROM "pad_links" l
    JOIN "shp_products" a ON a."id" = l."addon_product_id"
    WHERE l."product_id" = ${listing} AND l."enabled" = true
      AND a."status" = 'ACTIVE' AND a."catalogue_hidden" = false
    ORDER BY l."position", a."name"
    LIMIT ${MAX_ACCESSORIES}
  `)
  if (rows.length === 0) return null
  return {
    noun: rows[0]?.noun?.trim() || 'Accessories',
    items: rows.map((row) => ({
      productId: row.addon_id,
      name: row.name,
      url: productPage(base, row.slug),
      price: accessoryPrice(row, symbol),
      summary: truncate(plainText(row.short_description), 140),
      onlyWithSomeOptions: hasShowWhenRules(row.config),
    })),
  }
}

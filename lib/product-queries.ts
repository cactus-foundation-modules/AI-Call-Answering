import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '@/lib/db/prisma'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import {
  describePriceRange,
  effectivePrice,
  formatPrice,
  priceBasis,
  stockSummary,
} from './product-format'
import { resolveProductDeliveryOptions } from '@/modules/shop/lib/detail-delivery'
import { describeDeliveryTiming, type DeliveryTimingWords } from './delivery-words'
import { escapeLike, plainText, searchTokens, truncate } from './text'

// ---------------------------------------------------------------------------
// What the assistant can find out about the shop's products.
//
// Reads shop's tables directly - this module requires shop, and a read through
// raw SQL is the same pattern shop's own other modules use. Nothing is written.
// Only products a visitor could see are ever returned: ACTIVE, not hidden from
// the catalogue (which is how shop-variations hides its child rows) and not a
// spare part.
//
// Optional modules (variations, attributes) are used when their tables exist and
// ignored when not, so a shop without them still gets an assistant.
// ---------------------------------------------------------------------------

const SEARCH_LIMIT = 6
const DESCRIPTION_CHARS = 900
const FAQ_LIMIT = 8

const VISIBLE = Prisma.sql`p."status" = 'ACTIVE' AND p."catalogue_hidden" = false AND p."parts_only" = false`

export type ProductSummary = {
  id: string
  name: string
  price: string
  wasPrice: string | null
  availability: string
  category: string | null
  summary: string
}

const tableExistsCache = new Map<string, boolean>()

async function tableExists(table: string): Promise<boolean> {
  const cached = tableExistsCache.get(table)
  if (cached !== undefined) return cached
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`
  const present = rows[0]?.present === true
  tableExistsCache.set(table, present)
  return present
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

type ProductRow = {
  id: string
  name: string
  price: unknown
  sale_price: unknown
  short_description: string | null
  track_inventory: boolean
  stock_count: number | null
  low_stock_threshold: number | null
  out_of_stock_behaviour: string | null
  is_pre_order: boolean
  category_name: string | null
}

function toSummary(row: ProductRow, symbol: string): ProductSummary {
  const { now, was } = effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price))
  return {
    id: row.id,
    name: row.name,
    price: formatPrice(now, symbol),
    wasPrice: was === null ? null : formatPrice(was, symbol),
    availability: stockSummary({
      trackInventory: row.track_inventory,
      stockCount: row.stock_count,
      lowStockThreshold: row.low_stock_threshold,
      outOfStockBehaviour: row.out_of_stock_behaviour,
      isPreOrder: row.is_pre_order,
    }),
    category: row.category_name,
    summary: truncate(plainText(row.short_description), 220),
  }
}

/** One token matched anywhere a shopper would expect it to be. */
function tokenMatches(token: string): Prisma.Sql {
  const like = `%${escapeLike(token)}%`
  return Prisma.sql`(p."name" ILIKE ${like} OR p."sku" ILIKE ${like} OR p."short_description" ILIKE ${like}
    OR p."description" ILIKE ${like} OR c."name" ILIKE ${like})`
}

/** Favours a word in the name, then in the category, then the blurb. */
function tokenScore(token: string): Prisma.Sql {
  const like = `%${escapeLike(token)}%`
  // COALESCE: a product with no category or no blurb compares as NULL, and one
  // NULL would blank the whole sum and with it the ranking.
  return Prisma.sql`(COALESCE(p."name" ILIKE ${like}, false)::int * 4
    + COALESCE(c."name" ILIKE ${like}, false)::int * 2
    + COALESCE(p."short_description" ILIKE ${like}, false)::int)`
}

async function runSearch(tokens: string[], maxPrice: number | null, requireAll: boolean): Promise<ProductRow[]> {
  const matches = tokens.map(tokenMatches)
  const where = requireAll ? Prisma.join(matches, ' AND ') : Prisma.join(matches, ' OR ')
  const score = Prisma.join(tokens.map(tokenScore), ' + ')
  const priceCap = maxPrice === null
    ? Prisma.empty
    : Prisma.sql`AND COALESCE(NULLIF(p."sale_price", 0), p."price") <= ${maxPrice}`
  return prisma.$queryRaw<ProductRow[]>(Prisma.sql`
    SELECT p."id", p."name", p."price", p."sale_price", p."short_description", p."track_inventory",
           p."stock_count", p."low_stock_threshold", p."out_of_stock_behaviour", p."is_pre_order",
           c."name" AS category_name
    FROM "shp_products" p
    LEFT JOIN "shp_categories" c ON c."id" = p."master_category_id"
    WHERE ${VISIBLE} AND (${where}) ${priceCap}
    ORDER BY (${score}) DESC, COALESCE(p."popularity", 0) DESC, p."name"
    LIMIT ${SEARCH_LIMIT}
  `)
}

export type SearchOutcome = { products: ProductSummary[]; note: string | null }

export async function searchProducts(query: string, maxPrice: number | null): Promise<SearchOutcome> {
  const tokens = searchTokens(query)
  if (tokens.length === 0) return { products: [], note: 'Nothing to search for. Ask the caller what they are looking for.' }
  const config = await getShopConfigCached()

  let rows = await runSearch(tokens, maxPrice, true)
  let loosened = false
  if (rows.length === 0 && tokens.length > 1) {
    rows = await runSearch(tokens, maxPrice, false)
    loosened = rows.length > 0
  }
  const products = rows.map((row) => toSummary(row, config.currencySymbol))
  const basis = priceBasis(config.taxMode)
  if (products.length === 0) {
    return { products, note: 'No matching products. Try fewer or different words, or list the categories.' }
  }
  return {
    products,
    note: `Prices are ${basis}.${loosened ? ' These match only some of the words searched for, so check they suit.' : ''}`,
  }
}

const FaqShape = z.object({
  items: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
}).passthrough()

type DetailRow = ProductRow & {
  description: string | null
  type: string
  weight: unknown
  weight_unit: string | null
  dimension_l: unknown
  dimension_w: unknown
  dimension_h: unknown
  dimension_unit: string | null
  pre_order_dispatch_date: Date | null
  min_order_quantity: number | null
  faqs: unknown
}

export type ProductDetail = ProductSummary & {
  description: string
  dimensions: string | null
  weight: string | null
  minimumOrder: number | null
  preOrderDispatch: string | null
  options: Array<{ name: string; values: string[] }>
  priceRange: string | null
  specifications: Array<{ name: string; values: string[] }>
  questionsAnswered: Array<{ question: string; answer: string }>
  /** Every delivery service the shop offers this product, as the product page
   *  shows them. Empty when the shop publishes no delivery timing. */
  deliveryServices: DeliveryService[]
  deliveryNote: string
  priceNote: string
}

export type DeliveryService = DeliveryTimingWords & {
  service: string
  note: string | null
  price: string
}

/** The delivery services for a product, read through shop's own seam from
 *  whichever module publishes delivery timing - the same figures the product
 *  page shows. A shop without one simply has none. */
async function loadDeliveryServices(productId: string, symbol: string): Promise<DeliveryService[]> {
  const options = await resolveProductDeliveryOptions(productId)
  return options.map((option) => ({
    service: option.label,
    note: option.description ? truncate(plainText(option.description), 200) : null,
    price: option.price === 0 ? 'free' : formatPrice(option.price, symbol),
    ...describeDeliveryTiming(option.handlingDays, option.transitDays),
  }))
}

async function loadOptions(productId: string): Promise<Array<{ name: string; values: string[] }>> {
  if (!(await tableExists('svr_options'))) return []
  const rows = await prisma.$queryRaw<Array<{ name: string; labels: string[] }>>`
    SELECT o."name", array_agg(v."label" ORDER BY v."position") AS labels
    FROM "svr_options" o JOIN "svr_option_values" v ON v."option_id" = o."id"
    WHERE o."product_id" = ${productId}
    GROUP BY o."id", o."name", o."position" ORDER BY o."position"
  `
  return rows.map((row) => ({ name: row.name, values: row.labels.slice(0, 25) }))
}

async function loadVariationPrices(productId: string, symbol: string): Promise<string | null> {
  if (!(await tableExists('svr_variants'))) return null
  const rows = await prisma.$queryRaw<Array<{ low: unknown; high: unknown }>>`
    SELECT MIN(COALESCE(NULLIF(child."sale_price", 0), child."price")) AS low,
           MAX(COALESCE(NULLIF(child."sale_price", 0), child."price")) AS high
    FROM "svr_variants" sv JOIN "shp_products" child ON child."id" = sv."child_product_id"
    WHERE sv."product_id" = ${productId} AND sv."enabled" = true AND child."status" = 'ACTIVE'
  `
  const low = numberOrNull(rows[0]?.low)
  const high = numberOrNull(rows[0]?.high)
  return low === null || high === null ? null : describePriceRange({ low, high }, symbol)
}

async function loadSpecifications(productId: string): Promise<Array<{ name: string; values: string[] }>> {
  if (!(await tableExists('pat_product_values'))) return []
  // A variation's own attributes sit on its hidden child row, so they are read
  // too - when variations are installed at all.
  const owners = (await tableExists('svr_variants'))
    ? Prisma.sql`pv."product_id" = ${productId}
        OR pv."product_id" IN (SELECT "child_product_id" FROM "svr_variants" WHERE "product_id" = ${productId})`
    : Prisma.sql`pv."product_id" = ${productId}`
  const rows = await prisma.$queryRaw<Array<{ name: string; labels: string[] }>>(Prisma.sql`
    SELECT a."name", array_agg(DISTINCT v."label") AS labels
    FROM "pat_product_values" pv
    JOIN "pat_attribute_values" v ON v."id" = pv."value_id"
    JOIN "pat_attributes" a ON a."id" = v."attribute_id"
    WHERE ${owners}
    GROUP BY a."id", a."name", a."position" ORDER BY a."position"
    LIMIT 30
  `)
  return rows.map((row) => ({ name: row.name, values: row.labels.slice(0, 12) }))
}

function describeDimensions(row: DetailRow): string | null {
  const [l, w, h] = [numberOrNull(row.dimension_l), numberOrNull(row.dimension_w), numberOrNull(row.dimension_h)]
  if (l === null && w === null && h === null) return null
  const unit = row.dimension_unit ?? ''
  const parts = [l !== null ? `${l} long` : null, w !== null ? `${w} wide` : null, h !== null ? `${h} high` : null]
  return `${parts.filter((part): part is string => part !== null).join(', ')} ${unit}`.trim()
}

export async function getProductDetail(productId: string): Promise<ProductDetail | null> {
  const rows = await prisma.$queryRaw<DetailRow[]>`
    SELECT p."id", p."name", p."price", p."sale_price", p."short_description", p."description", p."type",
           p."track_inventory", p."stock_count", p."low_stock_threshold", p."out_of_stock_behaviour",
           p."is_pre_order", p."pre_order_dispatch_date", p."min_order_quantity", p."faqs",
           p."weight", p."weight_unit", p."dimension_l", p."dimension_w", p."dimension_h", p."dimension_unit",
           c."name" AS category_name
    FROM "shp_products" p
    LEFT JOIN "shp_categories" c ON c."id" = p."master_category_id"
    WHERE p."id" = ${productId} AND ${VISIBLE}
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null

  const config = await getShopConfigCached()
  const [options, priceRange, specifications, deliveryServices] = await Promise.all([
    loadOptions(productId),
    loadVariationPrices(productId, config.currencySymbol),
    loadSpecifications(productId),
    loadDeliveryServices(productId, config.currencySymbol),
  ])
  const faqs = FaqShape.safeParse(row.faqs)
  const weight = numberOrNull(row.weight)

  return {
    ...toSummary(row, config.currencySymbol),
    description: truncate(plainText(row.description) || plainText(row.short_description), DESCRIPTION_CHARS),
    dimensions: describeDimensions(row),
    weight: weight === null ? null : `${weight} ${row.weight_unit ?? ''}`.trim(),
    minimumOrder: row.min_order_quantity && row.min_order_quantity > 1 ? row.min_order_quantity : null,
    preOrderDispatch: row.pre_order_dispatch_date ? row.pre_order_dispatch_date.toISOString().slice(0, 10) : null,
    options,
    priceRange: options.length > 0 ? priceRange : null,
    specifications,
    questionsAnswered: faqs.success
      ? faqs.data.items.slice(0, FAQ_LIMIT).map((item) => ({ question: plainText(item.question), answer: truncate(plainText(item.answer), 300) }))
      : [],
    deliveryServices,
    deliveryNote: deliveryServices.length > 0
      ? `Delivery prices are ${priceBasis(config.taxMode)}. Times are working days, so weekends and bank holidays do not count.`
      : 'No delivery timing is published for this product. Do not guess one; offer a callback.',
    priceNote: `Prices are ${priceBasis(config.taxMode)}.`,
  }
}

export async function listTopCategories(): Promise<Array<{ name: string; description: string }>> {
  const rows = await prisma.$queryRaw<Array<{ name: string; short_description: string | null }>>`
    SELECT c."name", c."short_description"
    FROM "shp_categories" c
    WHERE c."parent_id" IS NULL
    ORDER BY c."position", c."name"
    LIMIT 40
  `
  return rows.map((row) => ({ name: row.name, description: truncate(plainText(row.short_description), 140) }))
}

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import {
  describePriceRange,
  effectivePrice,
  formatPrice,
  priceBasis,
  quoteQuantity,
  stockSummary,
  type QuantityQuote,
} from './product-format'
import { resolveProductDeliveryOptions } from '@/modules/shop/lib/detail-delivery'
import { getProductFaqCategoryChain } from '@/modules/shop/lib/db/catalogue'
import { normaliseFaqSet } from '@/modules/shop/lib/faq'
import { loadShopWideFaqs, resolveForProduct, toSpokenFaqs } from './faq-queries'
import { describeDeliveryTiming, type DeliveryTimingWords } from './delivery-words'
import { describeForecast, loadDeliveryForecast, type SpokenDeliveryService } from './delivery-forecast'
import { escapeLike, plainText, searchTokens, truncate } from './text'
import { normaliseSpokenSku, skuMatch, skuSearchDigits, type SkuMatch } from './sku'
import type { ProductRef } from '@/modules/unified-inbox/lib/products'

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

const VISIBLE = Prisma.sql`p."status" = 'ACTIVE' AND p."catalogue_hidden" = false AND p."parts_only" = false`

export type ProductSummary = {
  id: string
  name: string
  price: string
  wasPrice: string | null
  availability: string
  category: string | null
  summary: string
  /** True for a listing whose price is set by its variations. `price` is then a
   *  range ("from £90 to £140"), because the listing's own price is a figure the
   *  storefront never shows, and the exact price is one get_product call away. */
  hasVariations: boolean
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

type VariationSpread = { low: number; high: number; count: number }

/** The cheapest and dearest switched-on variation of each listing that has any. A
 *  listing's own price is usually zero - its variations set the price - so quoting
 *  it would tell the caller everything costs nothing. */
async function variationSpreads(productIds: string[]): Promise<Map<string, VariationSpread>> {
  const out = new Map<string, VariationSpread>()
  if (productIds.length === 0 || !(await tableExists('svr_variants'))) return out
  const rows = await prisma.$queryRaw<Array<{ product_id: string; low: unknown; high: unknown; count: unknown }>>(Prisma.sql`
    SELECT sv."product_id",
           MIN(COALESCE(NULLIF(child."sale_price", 0), child."price")) AS low,
           MAX(COALESCE(NULLIF(child."sale_price", 0), child."price")) AS high,
           COUNT(*)::int AS count
    FROM "svr_variants" sv JOIN "shp_products" child ON child."id" = sv."child_product_id"
    WHERE sv."product_id" IN (${Prisma.join(productIds)}) AND sv."enabled" = true AND child."status" = 'ACTIVE'
    GROUP BY sv."product_id"
  `)
  for (const row of rows) {
    const low = numberOrNull(row.low)
    const high = numberOrNull(row.high)
    const count = numberOrNull(row.count) ?? 0
    if (low !== null && high !== null && count > 0) out.set(row.product_id, { low, high, count })
  }
  return out
}

function toSummary(row: ProductRow, symbol: string, spread: VariationSpread | null = null): ProductSummary {
  const { now, was } = effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price))
  return {
    id: row.id,
    name: row.name,
    price: spread ? describePriceRange(spread, symbol) : formatPrice(now, symbol),
    wasPrice: spread || was === null ? null : formatPrice(was, symbol),
    hasVariations: spread !== null,
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
  const spreads = await variationSpreads(rows.map((row) => row.id))
  const products = rows.map((row) => toSummary(row, config.currencySymbol, spreads.get(row.id) ?? null))
  const basis = priceBasis(config.taxMode)
  if (products.length === 0) {
    return { products, note: 'No matching products. Try fewer or different words, or list the categories.' }
  }
  const ranged = products.some((product) => product.hasVariations)
  return {
    products,
    note: `Prices are ${basis}.${ranged ? ' A price given as a range belongs to a product sold in several variations: call get_product with the options the caller wants to get the exact price.' : ''}${loosened ? ' These match only some of the words searched for, so check they suit.' : ''}`,
  }
}

/** The questions this product's page prints: its own, its category chain's and
 *  the shop-wide ones, nearest answer winning. None when the shop has FAQs off. */
async function loadProductFaqs(productId: string, own: unknown): Promise<Array<{ question: string; answer: string }>> {
  const shop = await loadShopWideFaqs()
  if (!shop.enabled) return []
  const categories = await getProductFaqCategoryChain(productId)
  return toSpokenFaqs(resolveForProduct(normaliseFaqSet(own), categories, shop.items))
}

type DetailRow = ProductRow & {
  sku: string | null
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
  variationCount: number
  /** The product's own code, for a caller who asks for it. Never volunteered. */
  sku: string | null
  /** The cost and stock for the quantity asked about, when the item is settled
   *  (no variations, or one variation matched). Null otherwise. */
  quantityQuote: QuantityQuote | null
  /** The variations that fit the options asked for, each with its own id and
   *  exact price. Only present when get_product was given options. */
  matchingVariations: VariationMatch[] | null
  specifications: Array<{ name: string; values: string[] }>
  questionsAnswered: Array<{ question: string; answer: string }>
  /** Every delivery service the shop offers this product, as the product page
   *  shows them. Empty when the shop publishes no delivery timing. */
  deliveryServices: DeliveryService[]
  /** The same services worked out variation by variation, with real dates, for a
   *  product whose delivery depends on which variation is bought. Takes
   *  precedence over `deliveryServices` when present. */
  deliveryByVariation: SpokenDeliveryService[]
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

export type VariationMatch = {
  /** Pass this to email_summary as the product id to link this exact variation. */
  id: string
  options: string
  price: string
  wasPrice: string | null
  availability: string
  /** The code, for a caller who asks for it. Never volunteered. */
  sku: string | null
  /** Present when get_product was given a quantity. */
  quantityQuote: QuantityQuote | null
}

type VariationRow = {
  sku: string | null
  id: string
  name: string
  price: unknown
  sale_price: unknown
  track_inventory: boolean
  stock_count: number | null
  low_stock_threshold: number | null
  out_of_stock_behaviour: string | null
  is_pre_order: boolean
  options: string | null
}

const MAX_MATCHING_VARIATIONS = 8

/** The switched-on variations of a listing whose options contain every word the
 *  caller used ("black high back"), each with its own price. Empty list for no
 *  match; null when the words are all filler and nothing can be narrowed. */
async function findVariations(
  productId: string,
  wanted: string,
  symbol: string,
  quantity: number | null,
): Promise<{ matches: VariationMatch[]; total: number } | null> {
  const tokens = searchTokens(wanted, 10)
  if (tokens.length === 0 || !(await tableExists('svr_variants'))) return null
  const rows = await prisma.$queryRaw<VariationRow[]>`
    SELECT child."id", child."name", child."sku", child."price", child."sale_price", child."track_inventory",
           child."stock_count", child."low_stock_threshold", child."out_of_stock_behaviour", child."is_pre_order",
           (SELECT string_agg(ov."label", ' / ' ORDER BY o."position", ov."position")
              FROM "svr_variant_values" vv
              JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
              JOIN "svr_options" o ON o."id" = ov."option_id"
             WHERE vv."variant_id" = sv."id") AS options
    FROM "svr_variants" sv JOIN "shp_products" child ON child."id" = sv."child_product_id"
    WHERE sv."product_id" = ${productId} AND sv."enabled" = true AND child."status" = 'ACTIVE'
    ORDER BY sv."position", child."name"
    LIMIT 1000
  `
  const fits = rows.filter((row) => {
    const haystack = `${row.options ?? ''} ${row.name}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
  const matches = fits.slice(0, MAX_MATCHING_VARIATIONS).map((row): VariationMatch => {
    const { now, was } = effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price))
    const facts = {
      trackInventory: row.track_inventory,
      stockCount: row.stock_count,
      lowStockThreshold: row.low_stock_threshold,
      outOfStockBehaviour: row.out_of_stock_behaviour,
      isPreOrder: row.is_pre_order,
    }
    return {
      id: row.id,
      options: row.options ?? row.name,
      price: formatPrice(now, symbol),
      wasPrice: was === null ? null : formatPrice(was, symbol),
      availability: stockSummary(facts),
      sku: row.sku?.trim() || null,
      quantityQuote: quantity === null ? null : quoteQuantity(quantity, now, symbol, facts),
    }
  })
  return { matches, total: fits.length }
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

export async function getProductDetail(
  productId: string,
  wantedOptions: string | null = null,
  quantity: number | null = null,
): Promise<ProductDetail | null> {
  const rows = await prisma.$queryRaw<DetailRow[]>`
    SELECT p."id", p."name", p."sku", p."price", p."sale_price", p."short_description", p."description", p."type",
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
  const [options, spreads, specifications, deliveryServices, forecast, questionsAnswered, found] = await Promise.all([
    loadOptions(productId),
    variationSpreads([productId]),
    loadSpecifications(productId),
    loadDeliveryServices(productId, config.currencySymbol),
    loadDeliveryForecast(productId),
    loadProductFaqs(productId, row.faqs),
    wantedOptions ? findVariations(productId, wantedOptions, config.currencySymbol, quantity) : Promise.resolve(null),
  ])
  const spread = spreads.get(productId) ?? null
  const weight = numberOrNull(row.weight)
  const deliveryByVariation = forecast ? describeForecast(forecast, config.currencySymbol, config.taxMode) : []

  return {
    ...toSummary(row, config.currencySymbol, spread),
    description: truncate(plainText(row.description) || plainText(row.short_description), DESCRIPTION_CHARS),
    dimensions: describeDimensions(row),
    weight: weight === null ? null : `${weight} ${row.weight_unit ?? ''}`.trim(),
    minimumOrder: row.min_order_quantity && row.min_order_quantity > 1 ? row.min_order_quantity : null,
    preOrderDispatch: row.pre_order_dispatch_date ? row.pre_order_dispatch_date.toISOString().slice(0, 10) : null,
    options,
    priceRange: spread && options.length > 0 ? describePriceRange(spread, config.currencySymbol) : null,
    variationCount: spread?.count ?? 0,
    sku: row.sku?.trim() || null,
    quantityQuote: quantity !== null && !spread
      ? quoteQuantity(quantity, effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price)).now, config.currencySymbol, {
          trackInventory: row.track_inventory,
          stockCount: row.stock_count,
          lowStockThreshold: row.low_stock_threshold,
          outOfStockBehaviour: row.out_of_stock_behaviour,
          isPreOrder: row.is_pre_order,
        })
      : null,
    matchingVariations: found ? found.matches : null,
    specifications,
    questionsAnswered,
    deliveryServices: deliveryByVariation.length > 0 ? [] : deliveryServices,
    deliveryByVariation,
    deliveryNote: deliveryByVariation.length > 0
      ? `Dates are the earliest delivery if ordered today (${forecast?.today}) and prices are ${priceBasis(config.taxMode)}. Each line names which options it applies to: tell the caller which options arrive soonest and what the others get. If they have not said which option they want, give the soonest and say the rest are later.`
      : deliveryServices.length > 0
        ? `Delivery prices are ${priceBasis(config.taxMode)}. Times are working days, so weekends and bank holidays do not count.`
        : 'No delivery timing is published for this product. Do not guess one; offer a callback.',
    priceNote: priceNote(spread, found, wantedOptions, priceBasis(config.taxMode), quantity, row.min_order_quantity),
  }
}

/** What the model must do about price, given what was asked. A listing sold in
 *  variations has no single price: until the caller's options pin one down, only
 *  the range may be spoken, and it must be called a range. */
function priceNote(
  spread: VariationSpread | null,
  found: { matches: VariationMatch[]; total: number } | null,
  wantedOptions: string | null,
  basis: string,
  quantity: number | null = null,
  minimumOrder: number | null = null,
): string {
  const quantityNote = quantity === null
    ? ''
    : ` For ${quantity}, read the total and the stock from quantityQuote (on the product, or on each matching variation): never work the sum out yourself. Delivery prices and dates are for ONE item. How a delivery charge changes with quantity is not known here, so do not say whether it is per item or per order and do not multiply it: say the checkout shows the delivery total for the whole order, or offer a callback. A large quantity may not be covered by the dates given.${minimumOrder !== null && minimumOrder > quantity ? ` The minimum order is ${minimumOrder}, which is more than ${quantity}.` : ''}`
  return `${priceNoteCore(spread, found, wantedOptions, basis)}${quantityNote}`
}

function priceNoteCore(
  spread: VariationSpread | null,
  found: { matches: VariationMatch[]; total: number } | null,
  wantedOptions: string | null,
  basis: string,
): string {
  const base = `Prices are ${basis}.`
  if (!spread) return base
  if (!wantedOptions || found === null) {
    return `${base} This product is sold in ${spread.count} variations and the price depends on which is chosen, so the price above is a range. If the caller has named any options (colour, size, back height), call get_product again with those words in "options" to get the exact price of that variation. Never quote the range as if it were the price of their choice.`
  }
  if (found.matches.length === 0) {
    return `${base} No variation matches those options. Check the option values listed above and try again with words from them, or tell the caller you cannot find that combination.`
  }
  if (found.total > found.matches.length) {
    return `${base} ${found.total} variations fit those words and only ${found.matches.length} are listed. Ask the caller which option is still undecided, then call get_product again with more words in "options".`
  }
  if (found.matches.length === 1) {
    return `${base} Quote the price in matchingVariations: it is the exact price of what the caller asked about. Use its id in email_summary product_ids, not the product id.`
  }
  return `${base} Several variations fit. Quote the price of each that matters, or ask which one they want. Use the id of the chosen variation in email_summary product_ids, not the product id.`
}

/** What the assistant discussed, as references the unified inbox can print. An id
 *  is a variation when shop-variations lists it as a child, otherwise a product.
 *  Whether either is visible, priced or linkable is the inbox's call, made when
 *  the email goes: nothing the model wrote reaches the email. */
export async function toProductRefs(ids: string[]): Promise<ProductRef[]> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ''))]
  if (wanted.length === 0) return []
  const children = new Set<string>()
  if (await tableExists('svr_variants')) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "child_product_id" AS id FROM "svr_variants" WHERE "child_product_id" IN (${Prisma.join(wanted)})
    `)
    for (const row of rows) children.add(row.id)
  }
  return wanted.map((id) => ({ moduleName: 'shop', kind: children.has(id) ? 'variation' : 'product', id }))
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

type SkuRow = {
  id: string
  name: string
  sku: string | null
  price: unknown
  sale_price: unknown
  track_inventory: boolean
  stock_count: number | null
  low_stock_threshold: number | null
  out_of_stock_behaviour: string | null
  is_pre_order: boolean
  parent_id: string | null
  parent_name: string | null
  options: string | null
}

export type SkuHit = {
  /** Pass this to get_product. */
  productId: string
  name: string
  match: 'exact' | 'close'
  /** Set when the code belongs to one variation of a listing. */
  variation: { id: string; options: string; price: string; wasPrice: string | null; availability: string } | null
  /** For a code that is a whole product rather than a variation. */
  price: string | null
  availability: string | null
}

const MAX_SKU_HITS = 3

/** Products and variations whose code is the one the caller read out, allowing
 *  for a mis-heard letter. The code itself is never returned: the caller has it,
 *  and the assistant must not recite codes to people who did not ask. */
export async function findBySku(spoken: string): Promise<{ hits: SkuHit[]; note: string }> {
  const wanted = normaliseSpokenSku(spoken)
  if (wanted.length < 3) {
    return { hits: [], note: 'That is too short to be a product code. Ask the caller to read it again, letter by letter and digit by digit.' }
  }
  const digits = skuSearchDigits(wanted)
  const pattern = `%${digits ?? wanted}%`
  const config = await getShopConfigCached()

  const plain = await prisma.$queryRaw<SkuRow[]>(Prisma.sql`
    SELECT p."id", p."name", p."sku", p."price", p."sale_price", p."track_inventory", p."stock_count",
           p."low_stock_threshold", p."out_of_stock_behaviour", p."is_pre_order",
           NULL::text AS parent_id, NULL::text AS parent_name, NULL::text AS options
    FROM "shp_products" p
    WHERE ${VISIBLE} AND p."sku" IS NOT NULL
      AND regexp_replace(upper(p."sku"), '[^A-Z0-9]', '', 'g') LIKE ${pattern}
    LIMIT 60
  `)
  const variations = (await tableExists('svr_variants'))
    ? await prisma.$queryRaw<SkuRow[]>(Prisma.sql`
        SELECT child."id", child."name", child."sku", child."price", child."sale_price", child."track_inventory",
               child."stock_count", child."low_stock_threshold", child."out_of_stock_behaviour", child."is_pre_order",
               sv."product_id" AS parent_id, parent."name" AS parent_name,
               (SELECT string_agg(ov."label", ' / ' ORDER BY o."position", ov."position")
                  FROM "svr_variant_values" vv
                  JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
                  JOIN "svr_options" o ON o."id" = ov."option_id"
                 WHERE vv."variant_id" = sv."id") AS options
        FROM "svr_variants" sv
        JOIN "shp_products" child ON child."id" = sv."child_product_id"
        JOIN "shp_products" parent ON parent."id" = sv."product_id"
        WHERE sv."enabled" = true AND child."status" = 'ACTIVE'
          AND parent."status" = 'ACTIVE' AND parent."catalogue_hidden" = false AND parent."parts_only" = false
          AND child."sku" IS NOT NULL
          AND regexp_replace(upper(child."sku"), '[^A-Z0-9]', '', 'g') LIKE ${pattern}
        LIMIT 60
      `)
    : []

  const ranked: Array<{ row: SkuRow; match: Exclude<SkuMatch, null> }> = []
  for (const row of [...plain, ...variations]) {
    const match = row.sku ? skuMatch(spoken, row.sku) : null
    if (match) ranked.push({ row, match })
  }
  ranked.sort((a, b) => (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1))

  const hits = ranked.slice(0, MAX_SKU_HITS).map(({ row, match }): SkuHit => {
    const { now, was } = effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price))
    const availability = stockSummary({
      trackInventory: row.track_inventory,
      stockCount: row.stock_count,
      lowStockThreshold: row.low_stock_threshold,
      outOfStockBehaviour: row.out_of_stock_behaviour,
      isPreOrder: row.is_pre_order,
    })
    const price = formatPrice(now, config.currencySymbol)
    const wasPrice = was === null ? null : formatPrice(was, config.currencySymbol)
    if (row.parent_id) {
      return {
        productId: row.parent_id,
        name: row.parent_name ?? row.name,
        match,
        variation: { id: row.id, options: row.options ?? row.name, price, wasPrice, availability },
        price: null,
        availability: null,
      }
    }
    return { productId: row.id, name: row.name, match, variation: null, price, availability }
  })

  if (hits.length === 0) {
    return { hits, note: 'No product has that code. Ask the caller to read it once more, or to describe the item (type, colour, name on the product page). Never tell them codes cannot be searched.' }
  }
  const close = hits.some((hit) => hit.match === 'close')
  return {
    hits,
    note: `Prices are ${priceBasis(config.taxMode)}. ${close ? 'The code matched only closely (a letter may have been misheard), so confirm by saying what the item is by name and options, and let the caller agree before going on. ' : ''}Say the product name and its options, not the code, and do not read a code out unless the caller asks. A variation hit already tells you the exact option and price: do not ask which option they want. Use its variation id for email_summary and the productId for get_product.`,
  }
}

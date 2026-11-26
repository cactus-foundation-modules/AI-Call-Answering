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
  type StockFacts,
} from './product-format'
import { summariseStockByOption, type OptionAvailability } from './variation-stock'
import { canBuy, pickForSearch, type SearchVariation } from './search-variations'
import { headNoun, rankProducts, type IndexedProduct } from './search-rank'
import { carryChoices, picksRef, settledOptions, type OptionPick as LabelledPick } from './partial-choice'
import { pickVariations } from './variation-match'
import { resolveProductDeliveryOptions } from '@/modules/shop/lib/detail-delivery'
import { getProductFaqCategoryChain } from '@/modules/shop/lib/db/catalogue'
import { normaliseFaqSet } from '@/modules/shop/lib/faq'
import { loadShopWideFaqs, resolveForProduct, toSpokenFaqs } from './faq-queries'
import { describeDeliveryTiming, type DeliveryTimingWords } from './delivery-words'
import { describeForecast, loadDeliveryForecast, type SpokenDeliveryService } from './delivery-forecast'
import { neededByDate } from './needed-by'
import { plainText, searchTokens, truncate } from './text'
import { expandSearchWords, type Vocabulary } from './spelling'
import { normaliseSpokenSku, skuMatch, skuSearchDigits, type SkuMatch } from './sku'
import { loadAccessories, type AccessoryList } from './product-accessories'
import { pageBase, productPage, readPicks, type PageBase } from './product-links'
import type { ProductRef } from '@/modules/unified-inbox/lib/products'

// Copied from the chat assistant (modules/ai-agent-for-live-chat/lib/shop/product-queries.ts)
// and kept in step by hand: the two modules never import each other. Adapted
// for a phone call: nothing here asks the model to show or read out a web
// address, and the words say caller rather than caller.
// ---------------------------------------------------------------------------
// What the assistant can find out about the shop's products.
//
// Reads shop's tables directly - this module requires shop, and a read through
// raw SQL is the same pattern shop's own other modules use. Nothing is written.
// Only products a caller could see are ever returned: ACTIVE, not hidden from
// the catalogue (which is how shop-variations hides its child rows) and not a
// spare part.
//
// Optional modules (variations, attributes) are used when their tables exist and
// ignored when not, so a shop without them still gets an assistant.
// ---------------------------------------------------------------------------

const SEARCH_LIMIT = 6
/** How much of a product's description get_product reads. Long enough for
 *  what a page says further down: learned on a live chat, where "it has no
 *  onward connector, so it cannot daisy-chain" sat past the old 900 and the
 *  assistant told a caller the opposite. */
const DESCRIPTION_CHARS = 3500
/** The short description in full, as the page prints it. */
const DETAIL_SUMMARY_CHARS = 1000

const VISIBLE = Prisma.sql`p."status" = 'ACTIVE' AND p."catalogue_hidden" = false AND p."parts_only" = false`

export type ProductSummary = {
  id: string
  name: string
  /** The product's own page, for a text or an email. Never read out. */
  url: string | null
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
  slug: string | null
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

function toSummary(row: ProductRow, symbol: string, base: PageBase, spread: VariationSpread | null = null): ProductSummary {
  const { now, was } = effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price))
  return {
    id: row.id,
    name: row.name,
    url: productPage(base, row.slug),
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

/** Which optional tables this shop has for a search to read. */
type SearchReach = { variations: boolean; attributes: boolean }

async function searchReach(): Promise<SearchReach> {
  const [variations, attributes] = await Promise.all([tableExists('svr_variants'), tableExists('pat_product_values')])
  return { variations, attributes }
}

const VOCABULARY_TTL_MS = 10 * 60 * 1000
const VOCABULARY_MAX_WORDS = 30000
let vocabularyCache: { words: Vocabulary; at: number } | null = null

/** The words the shop's own product names and categories use, so a word the
 *  caller said slightly differently can be matched to the one the shop wrote.
 *  Read once and kept for a few minutes: it is a scan of names, not of pages. */
async function loadVocabulary(): Promise<Vocabulary> {
  if (vocabularyCache && Date.now() - vocabularyCache.at < VOCABULARY_TTL_MS) return vocabularyCache.words
  const rows = await prisma.$queryRaw<Array<{ word: string }>>(Prisma.sql`
    SELECT DISTINCT lower(w) AS word
    FROM (
      SELECT regexp_split_to_table(p."name" || ' ' || COALESCE(c."name", ''), '[^A-Za-z0-9]+') AS w
      FROM "shp_products" p LEFT JOIN "shp_categories" c ON c."id" = p."master_category_id"
      WHERE ${VISIBLE}
    ) words
    WHERE length(w) >= 3
    LIMIT ${VOCABULARY_MAX_WORDS}
  `)
  const words = new Set(rows.map((row) => row.word))
  vocabularyCache = { words, at: Date.now() }
  return words
}

/** Listings priced per search: enough that "the cheapest" is the cheapest of
 *  everything that matches well, not of the six most relevant. */
const CANDIDATE_LIMIT = 80
const INDEX_TTL_MS = 10 * 60 * 1000
const INDEX_BODY_CHARS = 4000
let indexCache: { products: IndexedProduct[]; at: number } | null = null
let familiesCache: { families: Map<string, string[]>; at: number } | null = null

function familyKey(name: string, label: string): string {
  return `${name.trim().toLowerCase()}|${label.trim().toLowerCase()}`
}

/**
 * The colour (or any other) families the shop's own filter files each value
 * under, read from the Filters module's rules where it is installed: "Finish:
 * Dark Teal" is in the filter "Blue". Keyed by option or attribute name and
 * value, both lower case. Read once and kept for a few minutes, like the
 * vocabulary. Nothing of that module is imported; a site without it has none.
 *
 * Learned on a live chat (the same tools serve calls): asked for a blue desk, the assistant found none and
 * told the caller the shop's own blue-filtered page showed no blue desks,
 * because every blue on it was called something else.
 */
async function loadFamilies(): Promise<Map<string, string[]>> {
  if (familiesCache && Date.now() - familiesCache.at < INDEX_TTL_MS) return familiesCache.families
  const families = new Map<string, string[]>()
  if (await tableExists('flt_filter_rules') && await tableExists('flt_filters')) {
    const rows = await prisma.$queryRaw<Array<{ option_name: string; value_label: string; label: string }>>(Prisma.sql`
      SELECT r."option_name", r."value_label", f."label" FROM "flt_filter_rules" r JOIN "flt_filters" f ON f."id" = r."filter_id"
      WHERE r."option_name" IS NOT NULL AND r."value_label" IS NOT NULL AND f."label" IS NOT NULL
      LIMIT 20000
    `)
    for (const row of rows) {
      const key = familyKey(row.option_name, row.value_label)
      const list = families.get(key) ?? []
      // Words only: a size band ("Up to 120cm") would let "120" match an 80cm
      // desk, so a filter label with a figure in it is never a family.
      if (/\d/.test(row.label)) continue
      if (!list.includes(row.label) && row.label.trim().toLowerCase() !== row.value_label.trim().toLowerCase()) list.push(row.label)
      families.set(key, list)
    }
  }
  familiesCache = { families, at: Date.now() }
  return families
}

/** The families one value belongs to. */
function familiesOf(families: ReadonlyMap<string, string[]>, name: string, label: string): string[] {
  return families.get(familyKey(name, label)) ?? []
}

/** "Name|Label" lines as the index query hands them, as words: each label
 *  and the families it is filed under. */
function pairWords(pairs: string | null, families: ReadonlyMap<string, string[]>): string {
  if (!pairs) return ''
  return pairs.split('\n').map((pair) => {
    const at = pair.indexOf('|')
    if (at < 0) return pair
    const name = pair.slice(0, at)
    const label = pair.slice(at + 1)
    return [label, ...familiesOf(families, name, label)].join(' ')
  }).join(' ')
}

/**
 * The words of every product a caller could see, read once and kept for a
 * few minutes like the vocabulary: name, category, blurb and description, and
 * the labels of its variations' options and the attribute values on it and
 * them (a colour family, "Green & Black"). One read of about a fifth of a
 * second, where matching each search word in SQL against options and
 * attributes took many seconds a search. Prices and stock are never cached:
 * they are read fresh for the products a search picks.
 */
async function loadSearchIndex(reach: SearchReach): Promise<IndexedProduct[]> {
  if (indexCache && Date.now() - indexCache.at < INDEX_TTL_MS) return indexCache.products
  const options = reach.variations
    ? Prisma.sql`(SELECT string_agg(o."name" || '|' || ov."label", E'\n') FROM "svr_options" o JOIN "svr_option_values" ov ON ov."option_id" = o."id" WHERE o."product_id" = p."id")`
    : Prisma.sql`NULL::text`
  const owned = reach.attributes
    ? reach.variations
      ? Prisma.sql`SELECT pv."product_id" AS owner_id, pv."value_id" FROM "pat_product_values" pv JOIN vis ON vis."id" = pv."product_id"
          UNION
          SELECT sv."product_id", pv."value_id" FROM "svr_variants" sv JOIN vis ON vis."id" = sv."product_id"
            JOIN "pat_product_values" pv ON pv."product_id" = sv."child_product_id" WHERE sv."enabled" = true`
      : Prisma.sql`SELECT pv."product_id" AS owner_id, pv."value_id" FROM "pat_product_values" pv JOIN vis ON vis."id" = pv."product_id"`
    : Prisma.sql`SELECT NULL::text AS owner_id, NULL::text AS value_id WHERE false`
  const labels = reach.attributes
    ? Prisma.sql`SELECT owned."owner_id", string_agg(a."name" || '|' || av."label", E'\n') AS labels FROM owned
        JOIN "pat_attribute_values" av ON av."id" = owned."value_id" JOIN "pat_attributes" a ON a."id" = av."attribute_id"
        GROUP BY owned."owner_id"`
    : Prisma.sql`SELECT NULL::text AS owner_id, NULL::text AS labels WHERE false`
  const rows = await prisma.$queryRaw<Array<{
    id: string
    name: string
    sku: string | null
    short_description: string | null
    description: string | null
    category_name: string | null
    option_labels: string | null
    attribute_labels: string | null
    category_ids: string[] | null
    master_category_id: string | null
    popularity: unknown
  }>>(Prisma.sql`
    WITH vis AS (SELECT p."id" FROM "shp_products" p WHERE ${VISIBLE}),
    owned AS (${owned}),
    labelled AS (${labels})
    SELECT p."id", p."name", p."sku", p."short_description", p."description", c."name" AS category_name,
           ${options} AS option_labels,
           labelled."labels" AS attribute_labels,
           ARRAY(SELECT pc."category_id" FROM "shp_product_categories" pc WHERE pc."product_id" = p."id") AS category_ids,
           p."master_category_id", p."popularity"
    FROM "shp_products" p
    LEFT JOIN "shp_categories" c ON c."id" = p."master_category_id"
    LEFT JOIN labelled ON labelled."owner_id" = p."id"
    WHERE ${VISIBLE}
  `)
  const families = await loadFamilies().catch(() => new Map<string, string[]>())
  const products = rows.map((row): IndexedProduct => ({
    id: row.id,
    name: row.name.toLowerCase(),
    variants: `${pairWords(row.option_labels, families)} ${pairWords(row.attribute_labels, families)}`.toLowerCase(),
    category: (row.category_name ?? '').toLowerCase(),
    body: `${row.sku ?? ''} ${plainText(row.short_description)} ${truncate(plainText(row.description), INDEX_BODY_CHARS)}`.toLowerCase(),
    categoryIds: [...new Set([row.master_category_id ?? '', ...(row.category_ids ?? [])].filter(Boolean))],
    popularity: numberOrNull(row.popularity) ?? 0,
    head: headNoun(row.name),
  }))
  indexCache = { products, at: Date.now() }
  return products
}

/** The category a slug or name means, with every category under it. Empty
 *  when the shop has none by that name. */
async function categoryTree(category: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH RECURSIVE tree AS (
      SELECT c."id" FROM "shp_categories" c WHERE c."slug" = ${category} OR lower(c."name") = lower(${category})
      UNION
      SELECT child."id" FROM "shp_categories" child JOIN tree ON child."parent_id" = tree."id"
    )
    SELECT "id" FROM tree LIMIT 500
  `)
  return rows.map((row) => row.id)
}

/** The products, in the order given, as search rows. */
async function productRows(ids: string[]): Promise<ProductRow[]> {
  if (ids.length === 0) return []
  const rows = await prisma.$queryRaw<ProductRow[]>(Prisma.sql`
    SELECT p."id", p."name", p."slug", p."price", p."sale_price", p."short_description", p."track_inventory",
           p."stock_count", p."low_stock_threshold", p."out_of_stock_behaviour", p."is_pre_order",
           c."name" AS category_name
    FROM "shp_products" p
    LEFT JOIN "shp_categories" c ON c."id" = p."master_category_id"
    WHERE p."id" IN (${Prisma.join(ids)}) AND ${VISIBLE}
  `)
  const order = new Map(ids.map((id, index) => [id, index]))
  return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

type SearchVariationRow = {
  product_id: string
  id: string
  price: unknown
  sale_price: unknown
  track_inventory: boolean
  stock_count: number | null
  low_stock_threshold: number | null
  out_of_stock_behaviour: string | null
  is_pre_order: boolean
  option_names: string[] | null
  option_values: string[] | null
  attribute_labels: string[] | null
  option_picks: unknown
}

type LoadedVariation = SearchVariation & { picks: LabelledPick[] }

/** Every switched-on variation of these listings, with the labels a search
 *  word can land on. */
async function searchVariations(productIds: string[], reach: SearchReach): Promise<Map<string, LoadedVariation[]>> {
  const out = new Map<string, LoadedVariation[]>()
  if (productIds.length === 0 || !reach.variations) return out
  const attributeLabels = reach.attributes
    ? Prisma.sql`(SELECT array_agg(av."label") FROM "pat_product_values" pv JOIN "pat_attribute_values" av ON av."id" = pv."value_id"
        WHERE pv."product_id" = child."id")`
    : Prisma.sql`NULL::text[]`
  const rows = await prisma.$queryRaw<SearchVariationRow[]>(Prisma.sql`
    SELECT sv."product_id", child."id", child."price", child."sale_price", child."track_inventory", child."stock_count",
           child."low_stock_threshold", child."out_of_stock_behaviour", child."is_pre_order",
           (SELECT array_agg(o."name" ORDER BY o."position", ov."position")
              FROM "svr_variant_values" vv
              JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
              JOIN "svr_options" o ON o."id" = ov."option_id"
             WHERE vv."variant_id" = sv."id") AS option_names,
           (SELECT array_agg(ov."label" ORDER BY o."position", ov."position")
              FROM "svr_variant_values" vv
              JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
              JOIN "svr_options" o ON o."id" = ov."option_id"
             WHERE vv."variant_id" = sv."id") AS option_values,
           ${attributeLabels} AS attribute_labels,
           (SELECT json_agg(json_build_array(o."name", ov."slug", ov."label") ORDER BY o."position", ov."position")
              FROM "svr_variant_values" vv
              JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
              JOIN "svr_options" o ON o."id" = ov."option_id"
             WHERE vv."variant_id" = sv."id") AS option_picks
    FROM "svr_variants" sv JOIN "shp_products" child ON child."id" = sv."child_product_id"
    WHERE sv."product_id" IN (${Prisma.join(productIds)}) AND sv."enabled" = true AND child."status" = 'ACTIVE'
    ORDER BY sv."product_id", sv."position"
  `)
  const families = await loadFamilies().catch(() => new Map<string, string[]>())
  for (const row of rows) {
    const optionValues = row.option_values ?? []
    const optionNames = row.option_names ?? []
    const aliases = optionValues.map((value, index) => familiesOf(families, optionNames[index] ?? '', value))
    const list = out.get(row.product_id) ?? []
    list.push({
      id: row.id,
      optionNames,
      optionValues,
      aliases,
      labels: [...optionValues, ...aliases.flat(), ...(row.attribute_labels ?? [])],
      price: effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price)).now,
      facts: {
        trackInventory: row.track_inventory,
        stockCount: row.stock_count,
        lowStockThreshold: row.low_stock_threshold,
        outOfStockBehaviour: row.out_of_stock_behaviour,
        isPreOrder: row.is_pre_order,
      },
      picks: readLabelledPicks(row.option_picks),
    })
    out.set(row.product_id, list)
  }
  return out
}

/** A search hit. For a listing sold in variations whose variations the words
 *  picked out (a colour, a size), `variation` is the cheapest of those - the
 *  one that can be bought when any can - with its own price, stock and page. */
export type SearchedProduct = ProductSummary & {
  /** `exact`: the words settle one variation, and `id` is its own. Otherwise
   *  `id` is the listing's, `url` picks only the options the words settled
   *  (`picks`, the inbox's spelling) and `price` is "from" the cheapest. */
  variation: { id: string; options: string; price: string; availability: string; url: string | null; exact: boolean; picks: string | null } | null
}

export type SearchOptions = {
  maxPrice: number | null
  /** Leave out what cannot be bought now. On unless the caller asked about
   *  a particular product. */
  inStockOnly: boolean
  /** 'price' lists the cheapest first, 'price_desc' the dearest first. */
  sort: 'relevance' | 'price' | 'price_desc'
  /** A category slug or name: only products in it (or under it). */
  category: string | null
}

export type SearchOutcome = { products: SearchedProduct[]; note: string | null }

type Ranked = { product: SearchedProduct; price: number }

function rankListing(row: ProductRow, variations: LoadedVariation[] | undefined, words: string[][], query: string, ctx: {
  symbol: string
  base: PageBase
  spread: VariationSpread | null
  inStockOnly: boolean
}): Ranked | null {
  const summary = toSummary(row, ctx.symbol, ctx.base, ctx.spread)
  if (!variations || variations.length === 0) {
    const facts: StockFacts = {
      trackInventory: row.track_inventory,
      stockCount: row.stock_count,
      lowStockThreshold: row.low_stock_threshold,
      outOfStockBehaviour: row.out_of_stock_behaviour,
      isPreOrder: row.is_pre_order,
    }
    if (ctx.inStockOnly && !canBuy(facts)) return null
    const price = effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price)).now
    return { product: { ...summary, variation: null }, price }
  }
  const pick = pickForSearch(variations, words, query)
  if (ctx.inStockOnly && pick.buyable.length === 0) return null
  const pool = ctx.inStockOnly ? pick.buyable : pick.fitting
  const low = Math.min(...pool.map((variation) => variation.price))
  const high = Math.max(...pool.map((variation) => variation.price))
  const buyableCount = pick.buyable.length
  const only = pick.fitting.length === 1 ? pick.fitting[0] : undefined
  const availability = only
    ? stockSummary(only.facts)
    : buyableCount === pick.fitting.length
      ? 'can be ordered in every option'
      : buyableCount === 0
        ? 'out of stock in every option right now'
        : `can be ordered in ${buyableCount} of ${pick.fitting.length} options`
  const chosen = pick.narrowed ? pick.cheapest : null
  return {
    product: {
      ...summary,
      price: describePriceRange({ low, high }, ctx.symbol),
      availability,
      variation: chosen ? searchedVariation(row, variations, pick.fitting, pool, chosen, ctx) : null,
    },
    price: chosen ? chosen.price : low,
  }
}

/** What a search hit offers for the variations its words picked out: the one
 *  variation when only one fits, else the listing with just the options the
 *  words settled picked (lib/shop/partial-choice.ts), never the cheapest fit
 *  with every other option chosen for the caller. */
function searchedVariation(
  row: ProductRow,
  all: readonly LoadedVariation[],
  fitting: readonly LoadedVariation[],
  pool: readonly LoadedVariation[],
  cheapest: LoadedVariation,
  ctx: { symbol: string; base: PageBase },
): NonNullable<SearchedProduct['variation']> {
  const exact = {
    id: cheapest.id,
    options: cheapest.optionValues.join(' / '),
    price: formatPrice(cheapest.price, ctx.symbol),
    availability: stockSummary(cheapest.facts),
    url: productPage(ctx.base, row.slug, cheapest.picks.map(([name, slug]) => [name, slug])),
    exact: true,
    picks: null,
  }
  if (fitting.length < 2) return exact
  const partial = partialChoice(all.map((v) => v.picks), fitting.map((v) => v.picks), pool.map((v) => v.price), ctx.base, row.slug, ctx.symbol)
  if (!partial) return exact
  return {
    id: row.id,
    options: partial.options,
    price: partial.priceFrom,
    availability: stockSummary(cheapest.facts),
    url: partial.url,
    exact: false,
    picks: partial.picks,
  }
}

/** Words that say what a product is NOT, or how to choose: they narrow the
 *  variations (lib/shop/variation-match.ts reads the whole query for that) but
 *  as search words they match nearly everything ("no" is in "now", "notes"). */
const NOT_SEARCH_WORDS = new Set(['no', 'not', 'without', 'with', 'cheap', 'cheapest', 'cheaper', 'lowest', 'price', 'best', 'your', 'ur', 'wot', 'what'])

/** Searched words, up to ten: a description with its options ("black height
 *  adjustable desk 120cm no modesty panel black frame") must not lose its
 *  last words to a cap of six. */
const SEARCH_WORDS = 10

export async function searchProducts(query: string, options: SearchOptions): Promise<SearchOutcome> {
  const tokens = searchTokens(query, SEARCH_WORDS + NOT_SEARCH_WORDS.size).filter((token) => !NOT_SEARCH_WORDS.has(token)).slice(0, SEARCH_WORDS)
  if (tokens.length === 0 && !options.category) return { products: [], note: 'Nothing to search for. Ask the caller what they are looking for.' }
  const config = await getShopConfigCached()
  const reach = await searchReach()
  const categories = options.category ? await categoryTree(options.category) : null
  if (categories && categories.length === 0) {
    return { products: [], note: `The shop has no category called "${options.category}". Search without one, or list the categories.` }
  }

  // Widen each word to its other spellings (light/lite, colour/color) before
  // searching, so a different spelling never reads as "the shop has none".
  const words = expandSearchWords(tokens, await loadVocabulary().catch(() => null))
  const index = await loadSearchIndex(reach)
  const found = rankProducts(index, words, {
    categoryIds: categories ? new Set(categories) : null,
    sort: options.sort,
    limit: CANDIDATE_LIMIT,
  })
  const loosened = found.loosened
  const rows = await productRows(found.ids)
  const ids = rows.map((row) => row.id)
  const [spreads, variations] = await Promise.all([variationSpreads(ids), searchVariations(ids, reach)])
  const base = pageBase(config.productUrlStyle)
  const ranked: Ranked[] = []
  let leftOut = 0
  for (const row of rows) {
    const hit = rankListing(row, variations.get(row.id), words, query, {
      symbol: config.currencySymbol,
      base,
      spread: spreads.get(row.id) ?? null,
      inStockOnly: options.inStockOnly,
    })
    if (hit) ranked.push(hit)
    else leftOut++
  }
  if (options.sort === 'price') ranked.sort((a, b) => a.price - b.price)
  if (options.sort === 'price_desc') ranked.sort((a, b) => b.price - a.price)
  const products = ranked.slice(0, SEARCH_LIMIT).map((entry) => entry.product)
  const basis = priceBasis(config.taxMode)
  if (products.length === 0) {
    return {
      products,
      note: leftOut > 0
        ? `${leftOut} matching product(s) exist but none can be bought right now (out of stock). Say nothing is available in that just now and offer the nearest alternative (another colour or a similar product), searching again.`
        : 'No matching products, even allowing for other spellings. Try fewer or different words, or list the categories.',
    }
  }
  const ranged = products.some((product) => product.hasVariations && !product.variation)
  const narrowed = products.some((product) => product.variation)
  return {
    products,
    note: [
      `Prices are ${basis}.`,
      options.sort === 'price' ? 'Listed cheapest first, by the price of what fits the words searched.' : '',
      options.sort === 'price_desc' ? 'Listed dearest first: the premium end of what fits the words searched.' : '',
      options.inStockOnly && leftOut > 0 ? `${leftOut} other match(es) are out of stock right now and were left out: do not offer them.` : '',
      narrowed ? 'Where a product has a variation, the words searched picked out what they want (a colour, a size): quote its price, not the product\'s range. A variation marked exact is one single variation. One not marked exact picks only the options they asked for and leaves the rest for them to choose: quote its price as "from", and never choose the other options for them.' : '',
      'Never read a web address out.',
      ranged ? 'A price given as a range belongs to a product sold in several variations: call get_product with the options the caller wants to get the exact price.' : '',
      loosened ? 'These match only some of the words searched for, so check they suit.' : '',
    ].filter(Boolean).join(' '),
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
  /** When several variations fit the options asked for: only the options the
   *  caller chose, as a page address that picks just those. Show this, not a
   *  variation, until they have chosen the rest. Null otherwise. */
  chosenOptions: PartialChoice | null
  /** When more variations fit than matchingVariations lists: for each option
   *  the caller has not settled, which values are in stock across EVERY fit.
   *  Names only. Null otherwise. */
  availableByOption: OptionAvailability[] | null
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
  /** Products the shop sells alongside this one (a pedestal, a power module, a
   *  monitor arm), each with its own id for get_product. Null for none. */
  accessories: AccessoryList | null
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
  /** This exact variation's page, for a text or an email. Never read out. */
  url: string | null
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
  option_names: string[] | null
  option_values: string[] | null
  option_picks: unknown
}

const MAX_MATCHING_VARIATIONS = 8

/** What findVariations found: the first few fits in full, how many fit in all,
 *  and - when more fit than are listed - a stock summary across every one. */
export type VariationsFound = {
  matches: VariationMatch[]
  total: number
  availableByOption: OptionAvailability[] | null
  /** Words no variation carries, set aside rather than ruling everything out. */
  ignored: string[]
  /** True when no variation had every word asked for: the matches are the
   *  nearest, and `unmet` says what they lack. */
  closest: boolean
  unmet: string[]
  /** When several fit: the options they all share (what the caller's words
   *  settled), as a page address with only those picked, their labels and the
   *  Unified Inbox's picks string. Null when one fits or nothing was settled. */
  chosen: PartialChoice | null
  /** Labels of options chosen earlier on the call that were kept. */
  carried: string[]
}

export type PartialChoice = { url: string | null; options: string; picks: string | null; priceFrom: string }

/** A variation's options as [name, slug, label], as the query hands them. */
function readLabelledPicks(value: unknown): LabelledPick[] {
  if (!Array.isArray(value)) return []
  const out: LabelledPick[] = []
  for (const entry of value) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
      out.push([entry[0], entry[1], typeof entry[2] === 'string' ? entry[2] : entry[1]])
    }
  }
  return out
}

/** A partial choice for these fits, or null when they settle nothing. */
function partialChoice(
  all: ReadonlyArray<readonly LabelledPick[]>,
  fits: ReadonlyArray<readonly LabelledPick[]>,
  prices: readonly number[],
  base: PageBase,
  slug: string | null,
  symbol: string,
): PartialChoice | null {
  if (fits.length < 2) return null
  const settled = settledOptions(all, fits)
  if (settled.length === 0) return null
  return {
    url: productPage(base, slug, settled.map(([name, value]) => [name, value])),
    options: settled.map(([, , label]) => label).join(' / '),
    picks: picksRef(settled),
    priceFrom: `from ${formatPrice(Math.min(...prices), symbol)}`,
  }
}

/** The switched-on variations of a listing the caller's words pick out ("black
 *  high back", "120cm no modesty panel black frame"), each with its own price.
 *  The matching rules are lib/shop/variation-match.ts: negations folded, words
 *  no variation carries set aside, a colour bound to the option it names, and
 *  the nearest variations when nothing has every word. Words that are all
 *  filler ("which colours are in stock?") fit every variation, so the stock
 *  summary still covers the lot. Null when the listing has no variations. */
async function findVariations(
  productId: string,
  wanted: string,
  symbol: string,
  quantity: number | null,
  base: PageBase,
  listingSlug: string | null,
  carried: ReadonlyMap<string, string> = new Map(),
): Promise<VariationsFound | null> {
  if (!(await tableExists('svr_variants'))) return null
  const rows = await prisma.$queryRaw<VariationRow[]>`
    SELECT child."id", child."name", child."sku", child."price", child."sale_price", child."track_inventory",
           child."stock_count", child."low_stock_threshold", child."out_of_stock_behaviour", child."is_pre_order",
           (SELECT array_agg(o."name" ORDER BY o."position", ov."position")
              FROM "svr_variant_values" vv
              JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
              JOIN "svr_options" o ON o."id" = ov."option_id"
             WHERE vv."variant_id" = sv."id") AS option_names,
           (SELECT array_agg(ov."label" ORDER BY o."position", ov."position")
              FROM "svr_variant_values" vv
              JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
              JOIN "svr_options" o ON o."id" = ov."option_id"
             WHERE vv."variant_id" = sv."id") AS option_values,
           (SELECT json_agg(json_build_array(o."name", ov."slug", ov."label") ORDER BY o."position", ov."position")
              FROM "svr_variant_values" vv
              JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
              JOIN "svr_options" o ON o."id" = ov."option_id"
             WHERE vv."variant_id" = sv."id") AS option_picks
    FROM "svr_variants" sv JOIN "shp_products" child ON child."id" = sv."child_product_id"
    WHERE sv."product_id" = ${productId} AND sv."enabled" = true AND child."status" = 'ACTIVE'
    ORDER BY sv."position", child."name"
    LIMIT 1000
  `
  const facts = (row: VariationRow): StockFacts => ({
    trackInventory: row.track_inventory,
    stockCount: row.stock_count,
    lowStockThreshold: row.low_stock_threshold,
    outOfStockBehaviour: row.out_of_stock_behaviour,
    isPreOrder: row.is_pre_order,
  })
  const families = await loadFamilies().catch(() => new Map<string, string[]>())
  const candidates = rows.map((row) => {
    const optionNames = row.option_names ?? []
    const optionValues = row.option_values ?? []
    return { row, optionNames, optionValues, aliases: optionValues.map((value, index) => familiesOf(families, optionNames[index] ?? '', value)), name: row.name }
  })
  const pick = pickVariations(wanted, candidates)
  const matched = pick.fits.map((index) => candidates[index]).filter((fit): fit is (typeof candidates)[number] => !!fit)
  // Options chosen earlier on the call still hold where these words left them
  // open (lib/shop/partial-choice.ts carryChoices).
  const carry = carried.size > 0 && !pick.closest
    ? carryChoices(matched.map((fit) => readLabelledPicks(fit.row.option_picks)), carried)
    : { kept: matched.map((_, index) => index), carried: [] as string[] }
  const fits = carry.kept.map((index) => matched[index]).filter((fit): fit is (typeof candidates)[number] => !!fit)
  const matches = fits.slice(0, MAX_MATCHING_VARIATIONS).map(({ row, optionValues }): VariationMatch => {
    const { now, was } = effectivePrice(numberOrNull(row.price) ?? 0, numberOrNull(row.sale_price))
    const stock = facts(row)
    return {
      id: row.id,
      url: productPage(base, listingSlug, readPicks(row.option_picks)),
      options: optionValues.length > 0 ? optionValues.join(' / ') : row.name,
      price: formatPrice(now, symbol),
      wasPrice: was === null ? null : formatPrice(was, symbol),
      availability: stockSummary(stock),
      sku: row.sku?.trim() || null,
      quantityQuote: quantity === null ? null : quoteQuantity(quantity, now, symbol, stock),
    }
  })
  const availableByOption = fits.length > matches.length
    ? summariseStockByOption(fits.map((fit) => ({ optionNames: fit.optionNames, optionValues: fit.optionValues, facts: facts(fit.row) })))
    : null
  const chosen = pick.closest
    ? null
    : partialChoice(
        candidates.map((fit) => readLabelledPicks(fit.row.option_picks)),
        fits.map((fit) => readLabelledPicks(fit.row.option_picks)),
        fits.map((fit) => effectivePrice(numberOrNull(fit.row.price) ?? 0, numberOrNull(fit.row.sale_price)).now),
        base,
        listingSlug,
        symbol,
      )
  return { matches, total: fits.length, availableByOption, ignored: pick.ignored, closest: pick.closest, unmet: pick.unmet, chosen, carried: carry.carried }
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

/** One product in full, found by its id, its page slug or its exact name. */
export async function getProductDetail(
  reference: string,
  wantedOptions: string | null = null,
  quantity: number | null = null,
  carriedFor: (productId: string) => ReadonlyMap<string, string> = () => new Map(),
  neededByWords: string | null = null,
): Promise<ProductDetail | null> {
  const rows = await prisma.$queryRaw<DetailRow[]>`
    SELECT p."id", p."name", p."slug", p."sku", p."price", p."sale_price", p."short_description", p."description", p."type",
           p."track_inventory", p."stock_count", p."low_stock_threshold", p."out_of_stock_behaviour",
           p."is_pre_order", p."pre_order_dispatch_date", p."min_order_quantity", p."faqs",
           p."weight", p."weight_unit", p."dimension_l", p."dimension_w", p."dimension_h", p."dimension_unit",
           c."name" AS category_name
    FROM "shp_products" p
    LEFT JOIN "shp_categories" c ON c."id" = p."master_category_id"
    WHERE (p."id" = ${reference} OR p."slug" = ${reference} OR lower(p."name") = lower(${reference})) AND ${VISIBLE}
    ORDER BY (p."id" = ${reference}) DESC, (p."slug" = ${reference}) DESC
    LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  // A slug may have been given: everything below is keyed on the real id.
  const productId = row.id

  const config = await getShopConfigCached()
  const base = pageBase(config.productUrlStyle)
  const [options, spreads, specifications, deliveryServices, forecast, questionsAnswered, found, accessories] = await Promise.all([
    loadOptions(productId),
    variationSpreads([productId]),
    loadSpecifications(productId),
    loadDeliveryServices(productId, config.currencySymbol),
    loadDeliveryForecast(productId),
    loadProductFaqs(productId, row.faqs),
    wantedOptions ? findVariations(productId, wantedOptions, config.currencySymbol, quantity, base, row.slug, carriedFor(productId)) : Promise.resolve(null),
    loadAccessories(productId, config.currencySymbol, base).catch(() => null),
  ])
  const spread = spreads.get(productId) ?? null
  const weight = numberOrNull(row.weight)
  const neededDate = forecast && neededByWords ? neededByDate(neededByWords, forecast.today) : null
  const neededBy = neededDate && neededByWords ? { date: neededDate, label: neededByWords.trim().slice(0, 40) } : null
  const deliveryByVariation = forecast ? describeForecast(forecast, config.currencySymbol, config.taxMode, neededBy) : []

  return {
    ...toSummary(row, config.currencySymbol, base, spread),
    summary: truncate(plainText(row.short_description), DETAIL_SUMMARY_CHARS),
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
    chosenOptions: found?.chosen ?? null,
    availableByOption: found?.availableByOption ?? null,
    specifications,
    questionsAnswered,
    deliveryServices: deliveryByVariation.length > 0 ? [] : deliveryServices,
    deliveryByVariation,
    deliveryNote: deliveryByVariation.length > 0
      ? `${neededBy ? `Each line says whether it arrives IN TIME or TOO LATE for ${neededBy.label} (${neededBy.date}): answer from that, never by comparing dates yourself. ` : ''}Dates are the earliest delivery if ordered today (${forecast?.today}) and prices are ${priceBasis(config.taxMode)}. Each line names which options it applies to: tell the caller which options arrive soonest and what the others get. If they have not said which option they want, give the soonest and say the rest are later.`
      : deliveryServices.length > 0
        ? `Delivery prices are ${priceBasis(config.taxMode)}. Times are working days, so weekends and bank holidays do not count.`
        : 'No delivery timing is published for this product. Do not guess one; offer a callback.',
    priceNote: priceNote(spread, found, wantedOptions, priceBasis(config.taxMode), quantity, row.min_order_quantity),
    accessories,
  }
}

/** What the model must do about price, given what was asked. A listing sold in
 *  variations has no single price: until the caller's options pin one down, only
 *  the range may be spoken, and it must be called a range. */
function priceNote(
  spread: VariationSpread | null,
  found: VariationsFound | null,
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
  found: VariationsFound | null,
  wantedOptions: string | null,
  basis: string,
): string {
  const base = `Prices are ${basis}.`
  if (!spread) return base
  if (!wantedOptions || found === null) {
    return `${base} This product is sold in ${spread.count} variations and the price depends on which is chosen, so the price above is a range. If the caller has named any options (colour, size, back height), call get_product again with those words in "options" to get the exact price of that variation. To answer which options are in stock, call get_product again with the options they have named (or "in stock" if none) and answer from availableByOption or each variation's availability. Never quote the range as if it were the price of their choice.`
  }
  const kept = found.carried.length > 0
    ? ` Kept from what they chose earlier on this call: ${found.carried.join(', ')}. Tell them you have kept it; if they meant to change it, they will say.`
    : ''
  const setAside = (found.ignored.length > 0
    ? ` These words match none of this product's options and were set aside: ${found.ignored.join(', ')}. They may describe the product itself (how a finish looks, say); check the options listed above if one matters.`
    : '') + kept
  if (found.matches.length === 0) {
    return `${base}${setAside} No variation matches those options. Read the option values listed above, map the caller's words onto them yourself (for example "no mod panel" is "Without Modesty Panel") and call get_product again with those exact values before telling the caller anything. Only if that also finds nothing, say which option they asked for is not sold.`
  }
  if (found.closest) {
    return `${base}${setAside} No variation has everything asked for; these are the nearest, and they do not have: ${found.unmet.join(', ')}. Tell the caller plainly which part of their choice is not sold and offer the nearest; never say the whole product is unavailable.`
  }
  const partly = found.chosen
    ? ` They have chosen only some options (${found.chosen.options}): quote chosenOptions.priceFrom, and to email or text it pass the product's own id, which goes with just their choices picked and the rest for them to choose. Never choose the other options for them by sending one of matchingVariations; only once they have chosen everything is it a single variation.`
    : ''
  if (found.total > found.matches.length) {
    return `${base}${setAside}${partly} ${found.total} variations fit those words and only ${found.matches.length} are listed. If the caller asked what is in stock or available, answer from availableByOption, which covers every one that fits: name about three values from inStock (and say which are out of stock if they asked), then offer the rest; do not ask them to pick first. A value counts as in stock if it is in stock in at least one of the combinations that fit. Only when they want the exact price of one particular combination, ask which option is still undecided, then call get_product again with more words in "options".`
  }
  if (found.matches.length === 1) {
    return `${base}${setAside} Quote the price in matchingVariations: it is the exact price of what the caller asked about. Use its id in email_summary product_ids, not the product id, so the email is for exactly this variation.`
  }
  return `${base}${setAside}${partly} Several variations fit. If the caller already chose the option that tells them apart earlier on this call, call get_product again with that added rather than asking. Otherwise quote the price of each that matters, or ask which one they want. Once they have chosen, use that variation's id in email_summary product_ids, not the product id.`
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
  slug: string | null
  parent_slug: string | null
  picks: unknown
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
  /** Not read out on a call, so not looked up here. */
  url?: string | null
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
    return { hits, note: 'No product has that code. Ask the caller to read it once more, or to describe the item (type, colour, name). Never tell them codes cannot be searched, never say where a code can be found, and never ask for an order confirmation or receipt: customers are not shown codes.' }
  }
  const close = hits.some((hit) => hit.match === 'close')
  return {
    hits,
    note: `Prices are ${priceBasis(config.taxMode)}. ${close ? 'The code matched only closely (a letter may have been misheard), so confirm by saying what the item is by name and options, and let the caller agree before going on. ' : ''}Say the product name and its options, not the code, and do not read a code out unless the caller asks. A variation hit already tells you the exact option and price: do not ask which option they want. Use its variation id for email_summary and the productId for get_product.`,
  }
}

/** A few switched-on variations of a listing, for asking what they can be
 *  bought with when the listing itself has no delivery menu (its variations
 *  each carry their own). Empty for a product with none. */
export async function variationIdsOf(listingId: string, limit = 40): Promise<string[]> {
  if (!(await tableExists('svr_variants'))) return []
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT sv."child_product_id" AS id FROM "svr_variants" sv
    WHERE sv."product_id" = ${listingId} AND sv."enabled" = true
    ORDER BY sv."position" LIMIT ${limit}
  `
  return rows.map((row) => row.id)
}

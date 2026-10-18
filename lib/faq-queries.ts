import { prisma } from '@/lib/db/prisma'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { getCategoryFaqChainBySlug, getCollectionFaqSetBySlug } from '@/modules/shop/lib/db/catalogue'
import {
  matchFaqQuestions,
  normaliseFaqItems,
  resolveCategoryFaqs,
  resolveProductFaqs,
  type ShpFaqItem,
  type ShpFaqSet,
} from '@/modules/shop/lib/faq'
import { escapeLike, plainText, truncate } from './text'

// ---------------------------------------------------------------------------
// The shop's frequently asked questions, as the assistant reads them.
//
// Shop keeps them in four places (product, category and its ancestors,
// collection, shop-wide) and owns the rules for which answer wins. Those rules
// are shop's (lib/faq.ts) and are used here as they stand, so the assistant
// says what the product page says. Nothing is written.
//
// The shop's "Product FAQs" switch gates the lot: with it off the storefront
// prints no questions, and the assistant must not quote ones the shop has
// chosen not to publish.
// ---------------------------------------------------------------------------

export const FAQ_LIMIT = 12
const ANSWER_CHARS = 400

export type SpokenFaq = { question: string; answer: string }

/** Stored questions as plain words, capped so a long answer cannot flood a call. */
export function toSpokenFaqs(items: readonly ShpFaqItem[], limit = FAQ_LIMIT): SpokenFaq[] {
  return items.slice(0, limit).map((item) => ({
    question: plainText(item.question),
    answer: truncate(plainText(item.answer), ANSWER_CHARS),
  }))
}

/** The shop-wide questions, or none when the shop has switched FAQs off. */
export async function loadShopWideFaqs(): Promise<{ enabled: boolean; items: ShpFaqItem[] }> {
  const config = await getShopConfigCached()
  return { enabled: config.productFaqsEnabled, items: normaliseFaqItems(config.productFaqs) }
}

/** What a product's page prints: its own, then its category chain, then the shop's. */
export function resolveForProduct(product: ShpFaqSet, categories: ShpFaqSet[], shopWide: ShpFaqItem[]): ShpFaqItem[] {
  return resolveProductFaqs({ product, categories, shopWide })
}

type NamedRow = { name: string; slug: string }

/** The best row for what the caller said: an exact name or slug beats a partial. */
async function findCategory(name: string): Promise<NamedRow | null> {
  const like = `%${escapeLike(name)}%`
  const rows = await prisma.$queryRaw<NamedRow[]>`
    SELECT "name", "slug" FROM "shp_categories"
    WHERE "name" ILIKE ${like} OR "slug" ILIKE ${like}
    ORDER BY (lower("name") = lower(${name}) OR lower("slug") = lower(${name})) DESC,
             length("name") ASC, "position" ASC
    LIMIT 1
  `
  return rows[0] ?? null
}

async function findCollection(name: string): Promise<NamedRow | null> {
  const like = `%${escapeLike(name)}%`
  const rows = await prisma.$queryRaw<NamedRow[]>`
    SELECT "name", "slug" FROM "shp_collections"
    WHERE "name" ILIKE ${like} OR "slug" ILIKE ${like}
    ORDER BY (lower("name") = lower(${name}) OR lower("slug") = lower(${name})) DESC,
             length("name") ASC, "position" ASC
    LIMIT 1
  `
  return rows[0] ?? null
}

/** Names of the categories and collections that carry questions of their own,
 *  so the assistant can say what it has answers for. */
async function listTopicsWithFaqs(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ name: string }>>`
    SELECT "name" FROM (
      SELECT "name", "position" FROM "shp_categories" WHERE "faqs" IS NOT NULL
      UNION ALL
      SELECT "name", "position" FROM "shp_collections" WHERE "faqs" IS NOT NULL
    ) t ORDER BY "position", "name" LIMIT 40
  `
  return rows.map((row) => row.name)
}

export type FaqOutcome = {
  ok: boolean
  scope: 'category' | 'collection' | 'shop'
  topic: string | null
  questions: SpokenFaq[]
  note: string
  topicsWithQuestions?: string[]
}

export type FaqRequest = { category: string | null; collection: string | null; query: string | null }

export async function lookupFaqs(request: FaqRequest): Promise<FaqOutcome> {
  const shop = await loadShopWideFaqs()
  if (!shop.enabled) {
    return { ok: true, scope: 'shop', topic: null, questions: [], note: 'This shop publishes no frequently asked questions. Do not guess an answer; offer a callback.' }
  }

  let scope: FaqOutcome['scope'] = 'shop'
  let topic: string | null = null
  let items: ShpFaqItem[] = shop.items
  let unmatched: string | null = null

  if (request.category) {
    const found = await findCategory(request.category)
    if (found) {
      scope = 'category'
      topic = found.name
      items = resolveCategoryFaqs(await getCategoryFaqChainBySlug(found.slug), shop.items)
    } else {
      unmatched = request.category
    }
  } else if (request.collection) {
    const found = await findCollection(request.collection)
    if (found) {
      scope = 'collection'
      topic = found.name
      const set = await getCollectionFaqSetBySlug(found.slug)
      // A collection has no parent: its own questions, then the shop's, unless it says otherwise.
      items = resolveForProduct(set, [], shop.items)
    } else {
      unmatched = request.collection
    }
  }

  const query = request.query?.trim() ?? ''
  const matched = query ? matchFaqQuestions(items, query, FAQ_LIMIT) : items
  const questions = toSpokenFaqs(matched)

  const parts: string[] = []
  if (unmatched) parts.push(`No category or collection called "${unmatched}" was found, so these are the shop-wide questions.`)
  if (questions.length === 0) {
    parts.push(query ? 'Nothing written matches that question. Do not guess; offer a callback.' : 'No questions have been written for this. Do not guess; offer a callback.')
  } else {
    parts.push('Answer only from these. If none of them covers what the caller asked, say you do not have that to hand and offer a callback.')
  }

  return {
    ok: true,
    scope,
    topic,
    questions,
    note: parts.join(' '),
    topicsWithQuestions: scope === 'shop' && !query ? await listTopicsWithFaqs() : undefined,
  }
}

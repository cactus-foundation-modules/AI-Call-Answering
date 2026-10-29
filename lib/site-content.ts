import { prisma } from '@/lib/db/prisma'

// ---------------------------------------------------------------------------
// The shop's own words, searched live: its published pages (terms, delivery,
// returns, about) and, where the Gazette module is installed, its articles.
//
// The owner used to paste policy into the extra instructions, where it drifted
// from the real pages; one caller with a damaged desk could not be told where
// to upload the photos, though the returns page says exactly that. Now the
// assistant asks for the passages that match the question and quotes them.
//
// Pages are Puck trees with rich text nested inside blocks, so the text is
// walked out generically (no knowledge of any block palette), split into short
// passages under their nearest heading, and scored by how many of the
// question's words each contains. Cached for a few minutes: a page edit
// reaches the phone within that.
// ---------------------------------------------------------------------------

export type Passage = { source: string; heading: string; text: string }

const CACHE_MS = 5 * 60_000
const PASSAGE_CHARS = 700
const MAX_PASSAGES = 3

// Keys whose strings are never copy: ids, colours, urls, styling.
const SKIP_KEY = /(^id$|Id$|url|href|src|color|colour|class|icon|slug|padding|margin|width|height|align|variant|mode|target|style|bg|pattern|image|menu|gap|size|sticky|type|meta|og)/i
const HEADING_TYPES = /^(heading|Heading|SectionHeading|Title)$/

function looksLikeCopy(value: string): boolean {
  const text = value.trim()
  if (text.length < 3) return false
  if (/^#[0-9a-f]{3,8}$/i.test(text) || /^var\(--/.test(text)) return false
  if (/^https?:\/\//i.test(text) || text.startsWith('/')) return false
  // Settings are single words ("false", "none", "normal", "lg"); copy has spaces.
  // A one-word heading still arrives as a rich-text run, which is read apart.
  if (!/\s/.test(text)) return false
  return true
}

function stripHtml(html: string): string {
  return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/gi, ' ')
}

type Chunk = { heading: boolean; text: string }

/** Text out of any Puck tree, including rich-text documents nested in a
 *  block's props, in reading order, with headings marked. Pure. */
export function extractChunks(data: unknown): Chunk[] {
  const chunks: Chunk[] = []
  const visit = (node: unknown, key: string, inHeading: boolean): void => {
    if (typeof node === 'string') {
      if (!SKIP_KEY.test(key) && looksLikeCopy(node)) {
        const text = stripHtml(node).replace(/\s+/g, ' ').trim()
        if (text) chunks.push({ heading: inHeading || /^(title|heading)$/i.test(key), text })
      }
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, key, inHeading)
      return
    }
    if (!node || typeof node !== 'object') return
    const object = node as Record<string, unknown>
    const isHeading = inHeading || (typeof object.type === 'string' && HEADING_TYPES.test(object.type))
    // A rich-text leaf: { type: 'text', text: '...' }.
    if (object.type === 'text' && typeof object.text === 'string') {
      const text = object.text.replace(/\s+/g, ' ').trim()
      if (text) chunks.push({ heading: isHeading, text })
      return
    }
    for (const [childKey, value] of Object.entries(object)) {
      if (childKey === 'root') continue
      visit(value, childKey, isHeading)
    }
  }
  visit(data, '', false)
  // Rich text arrives one run at a time ("Report it ", "within five days"):
  // runs that are not headings and follow each other are one paragraph.
  return chunks
}

/** Passages of about PASSAGE_CHARS, each under the heading it sits beneath. */
export function toPassages(source: string, chunks: Chunk[]): Passage[] {
  const passages: Passage[] = []
  let heading = ''
  let buffer = ''
  const flush = () => {
    if (buffer.trim()) passages.push({ source, heading, text: buffer.trim() })
    buffer = ''
  }
  for (const chunk of chunks) {
    if (chunk.heading) {
      flush()
      heading = chunk.text.slice(0, 120)
      continue
    }
    if (buffer.length + chunk.text.length > PASSAGE_CHARS) flush()
    buffer += `${buffer ? ' ' : ''}${chunk.text}`
  }
  flush()
  return passages
}

const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'can', 'what', 'how', 'does', 'with', 'are', 'have', 'from', 'that', 'this', 'about', 'there', 'will', 'when', 'which', 'any', 'get', 'its', 'our', 'is', 'do', 'to', 'of', 'a', 'an', 'in', 'on', 'it', 'my', 'me', 'i', 'be', 'or', 'if', 'at'])

export function queryTokens(query: string): string[] {
  return [...new Set(query.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((word) => word.length > 2 && !STOP.has(word)))]
}

/** A word matches its plural and simple endings ("photo" finds "photos"). */
function stem(word: string): string {
  return word.replace(/(ies|es|s|ing|ed)$/, '') || word
}

/** The best passages for a question. A word in the heading or page title
 *  counts double: "returns" belongs to the returns page first. Pure. */
export function rankPassages(passages: Passage[], query: string, limit: number = MAX_PASSAGES): Passage[] {
  const tokens = queryTokens(query).map(stem)
  if (tokens.length === 0) return []
  const scored = passages.map((passage) => {
    const body = passage.text.toLowerCase()
    const label = `${passage.source} ${passage.heading}`.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (body.includes(token)) score += 1
      if (label.includes(token)) score += 2
    }
    return { passage, score }
  })
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.passage)
}

let pagesCache: { at: number; passages: Passage[]; titles: string[] } | null = null
let postsCache: { at: number; passages: Passage[] } | null = null

async function tableExists(table: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass(${`public.${table}`}) IS NOT NULL AS present`
  return rows[0]?.present === true
}

async function pagePassages(): Promise<{ passages: Passage[]; titles: string[] }> {
  if (pagesCache && Date.now() - pagesCache.at < CACHE_MS) return pagesCache
  const rows = await prisma.$queryRaw<Array<{ title: string; publishedData: unknown; body: string | null }>>`
    SELECT "title", "publishedData", "body" FROM "InfoPage" WHERE "status"::text = 'published' ORDER BY "title"
  `
  const passages: Passage[] = []
  for (const row of rows) {
    const chunks = row.publishedData ? extractChunks(row.publishedData) : [{ heading: false, text: stripHtml(row.body ?? '').replace(/\s+/g, ' ').trim() }]
    passages.push(...toPassages(row.title, chunks))
  }
  pagesCache = { at: Date.now(), passages, titles: rows.map((row) => row.title) }
  return pagesCache
}

async function postPassages(): Promise<Passage[]> {
  if (postsCache && Date.now() - postsCache.at < CACHE_MS) return postsCache.passages
  if (!(await tableExists('gz_posts'))) return []
  const rows = await prisma.$queryRaw<Array<{ title: string; excerpt: string | null; builder_data: unknown }>>`
    SELECT "title", "excerpt", "builder_data" FROM "gz_posts"
    WHERE "status" = 'PUBLISHED' AND "is_private" = false AND ("published_at" IS NULL OR "published_at" <= CURRENT_TIMESTAMP)
    ORDER BY "published_at" DESC NULLS LAST LIMIT 500
  `
  const passages: Passage[] = []
  for (const row of rows) {
    const chunks = [
      ...(row.excerpt ? [{ heading: false, text: row.excerpt }] : []),
      ...extractChunks(row.builder_data),
    ]
    passages.push(...toPassages(row.title, chunks))
  }
  postsCache = { at: Date.now(), passages }
  return passages
}

export async function searchPages(query: string): Promise<{ passages: Passage[]; pages: string[] }> {
  const { passages, titles } = await pagePassages()
  return { passages: rankPassages(passages, query), pages: titles }
}

export async function searchGuides(query: string): Promise<Passage[]> {
  return rankPassages(await postPassages(), query)
}

// -- reviews ------------------------------------------------------------------

export type ReviewDigest = {
  count: number
  averageRating: number | null
  /** Short quotes, best match for the question first, newest otherwise. */
  quotes: Array<{ rating: number; title: string; text: string; verifiedPurchase: boolean }>
}

/** Published reviews for a product and, for a listing with variations, every
 *  variation of it (shoppers review the colour they bought). */
export async function productReviews(productId: string, query: string | null): Promise<ReviewDigest | null> {
  if (!(await tableExists('rvw_reviews'))) return null
  const variations = await tableExists('svr_variants')
  const rows = await prisma.$queryRaw<Array<{ rating: number; title: string | null; body: string | null; verified_purchase: boolean }>>`
    SELECT r."rating", r."title", r."body", r."verified_purchase" FROM "rvw_reviews" r
    WHERE r."status" = 'PUBLISHED'
      AND (r."product_id" = ${productId}
        OR (${variations} AND r."product_id" IN (
          SELECT "child_product_id" FROM "svr_variants" WHERE "product_id" = ${productId}
          UNION SELECT "product_id" FROM "svr_variants" WHERE "child_product_id" = ${productId})))
    ORDER BY COALESCE(r."published_at", r."created_at") DESC LIMIT 200
  `
  if (rows.length === 0) return { count: 0, averageRating: null, quotes: [] }
  const average = rows.reduce((sum, row) => sum + row.rating, 0) / rows.length
  const tokens = query ? queryTokens(query).map(stem) : []
  const ranked = rows
    .map((row, index) => {
      const text = `${row.title ?? ''} ${row.body ?? ''}`.toLowerCase()
      return { row, score: tokens.filter((token) => text.includes(token)).length * 100 - index }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
  return {
    count: rows.length,
    averageRating: Math.round(average * 10) / 10,
    quotes: ranked.map(({ row }) => ({
      rating: row.rating,
      title: (row.title ?? '').slice(0, 120),
      text: (row.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
      verifiedPurchase: row.verified_purchase,
    })),
  }
}

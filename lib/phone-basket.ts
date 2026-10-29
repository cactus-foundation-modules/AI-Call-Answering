import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrl } from '@/lib/config/env'

// ---------------------------------------------------------------------------
// A basket put together on the phone.
//
// A caller with a long list used to finish the call with nothing to act on:
// seven minutes of "and forty of the black ones" and then a goodbye. Now the
// assistant fills a basket line by line and sends a link. Opening it puts the
// lines into that browser's own basket (public/basket route) and lands on the
// basket page, where prices, stock and delivery are worked out by the shop as
// for any other basket.
//
// Lines only, the shop's own shape. Nothing about the caller goes in the row or
// the link, so a forwarded or prefetched link reveals product names and
// nothing more - the same bargain abandoned-carts-for-shop strikes.
// ---------------------------------------------------------------------------

/** The shop's basket holds 200 lines; a phone basket never needs more. */
export const MAX_BASKET_LINES = 200
export const MAX_LINE_QUANTITY = 10_000
/** How long a link keeps working. Long enough to get sign-off from a manager,
 *  short enough that an old link in somebody's texts goes stale. */
export const BASKET_LINK_DAYS = 30

export type BasketLine = { productId: string; quantity: number }

export type BasketItemInput = { product_id: string; quantity: number }

/** Merges repeats of one product (the caller said "and another ten of those")
 *  and drops anything not a whole positive number. Pure. */
export function normaliseBasketItems(items: readonly BasketItemInput[]): BasketLine[] {
  const merged = new Map<string, number>()
  for (const item of items) {
    const id = item.product_id.trim()
    const quantity = Math.floor(item.quantity)
    if (!id || !Number.isFinite(quantity) || quantity < 1) continue
    merged.set(id, Math.min((merged.get(id) ?? 0) + quantity, MAX_LINE_QUANTITY))
  }
  return [...merged.entries()].slice(0, MAX_BASKET_LINES).map(([productId, quantity]) => ({ productId, quantity }))
}

export type CheckedLine = BasketLine & { name: string; options: string }
export type BasketCheck = {
  lines: CheckedLine[]
  /** Ids that are a whole listing with variations: the caller must choose one. */
  needsOptions: Array<{ productId: string; name: string }>
  /** Ids that are not a product the shop sells. */
  unknown: string[]
}

type ProductRow = { id: string; name: string; options: string | null; parent_name: string | null; has_variations: boolean; buyable: boolean }

async function hasVariationsTable(): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ present: boolean }>>`SELECT to_regclass('public.svr_variants') IS NOT NULL AS present`
  return rows[0]?.present === true
}

/** What each id really is. A variation is fine; a listing that has variations
 *  is not, because the basket needs to know which colour and size; anything
 *  inactive or unknown is refused rather than quietly dropped at checkout. */
export async function checkBasketLines(lines: BasketLine[]): Promise<BasketCheck> {
  const out: BasketCheck = { lines: [], needsOptions: [], unknown: [] }
  if (lines.length === 0) return out
  const ids = lines.map((line) => line.productId)
  const variations = await hasVariationsTable()
  const rows = await prisma.$queryRaw<ProductRow[]>(
    variations
      ? Prisma.sql`
          SELECT p."id", p."name",
            (SELECT string_agg(ov."label", ' / ' ORDER BY o."position", ov."position")
               FROM "svr_variant_values" vv
               JOIN "svr_option_values" ov ON ov."id" = vv."option_value_id"
               JOIN "svr_options" o ON o."id" = ov."option_id"
              WHERE vv."variant_id" = child_of."id") AS options,
            parent."name" AS parent_name,
            EXISTS (SELECT 1 FROM "svr_variants" sv WHERE sv."product_id" = p."id" AND sv."enabled" = true) AS has_variations,
            (p."status" = 'ACTIVE' AND p."parts_only" = false
              AND (child_of."id" IS NOT NULL OR p."catalogue_hidden" = false)) AS buyable
          FROM "shp_products" p
          LEFT JOIN "svr_variants" child_of ON child_of."child_product_id" = p."id" AND child_of."enabled" = true
          LEFT JOIN "shp_products" parent ON parent."id" = child_of."product_id"
          WHERE p."id" IN (${Prisma.join(ids)})`
      : Prisma.sql`
          SELECT p."id", p."name", NULL::text AS options, NULL::text AS parent_name, false AS has_variations,
            (p."status" = 'ACTIVE' AND p."parts_only" = false AND p."catalogue_hidden" = false) AS buyable
          FROM "shp_products" p WHERE p."id" IN (${Prisma.join(ids)})`,
  )
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const line of lines) {
    const row = byId.get(line.productId)
    if (!row || !row.buyable) out.unknown.push(line.productId)
    else if (row.has_variations) out.needsOptions.push({ productId: row.id, name: row.name })
    else out.lines.push({ ...line, name: row.parent_name ?? row.name, options: row.options ?? '' })
  }
  return out
}

export function basketUrl(token: string, siteUrl: string = getSiteUrl()): string {
  return `${siteUrl}/api/m/ai-call-answering/public/basket?t=${encodeURIComponent(token)}`
}

/** Saves the call's basket, replacing any earlier version and keeping its
 *  token, so a link already sent still opens the latest list. */
export async function saveCallBasket(callId: string, lines: BasketLine[]): Promise<{ token: string }> {
  const token = randomBytes(18).toString('base64url')
  const json = JSON.stringify(lines)
  const rows = await prisma.$queryRaw<Array<{ token: string }>>`
    INSERT INTO "acall_baskets" ("call_id", "token", "lines")
    VALUES (${callId}, ${token}, ${json}::jsonb)
    ON CONFLICT ("call_id") DO UPDATE SET "lines" = EXCLUDED."lines", "updated_at" = CURRENT_TIMESTAMP
    RETURNING "token"
  `
  return { token: rows[0]?.token ?? token }
}

export async function getCallBasket(callId: string): Promise<{ token: string; lines: BasketLine[] } | null> {
  const rows = await prisma.$queryRaw<Array<{ token: string; lines: unknown }>>`
    SELECT "token", "lines" FROM "acall_baskets" WHERE "call_id" = ${callId} LIMIT 1
  `
  const row = rows[0]
  return row ? { token: row.token, lines: readLines(row.lines) } : null
}

function readLines(value: unknown): BasketLine[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const line = item as Record<string, unknown>
    return typeof line?.productId === 'string' && typeof line.quantity === 'number' && line.quantity > 0
      ? [{ productId: line.productId, quantity: line.quantity }]
      : []
  })
}

/** The lines behind a link, or null when it is unknown or has expired. Marks
 *  the first opening, so the call's overview can say whether it was used. */
export async function openBasketByToken(token: string): Promise<BasketLine[] | null> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null
  const rows = await prisma.$queryRaw<Array<{ lines: unknown }>>`
    UPDATE "acall_baskets" SET "opened_at" = COALESCE("opened_at", CURRENT_TIMESTAMP)
    WHERE "token" = ${token} AND "created_at" > CURRENT_TIMESTAMP - make_interval(days => ${BASKET_LINK_DAYS}::int)
    RETURNING "lines"
  `
  return rows[0] ? readLines(rows[0].lines) : null
}

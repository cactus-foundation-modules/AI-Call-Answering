// ---------------------------------------------------------------------------
// The products a call has actually been about, kept on the call
// (acall_calls.discussed_products) so a note emailed later lists them even
// when the model forgets to say which.
//
// The chat assistant shipped a note of a chat about a desk with no desk in it:
// the model looked the desk up three times and then passed no product_ids. This
// assistant's email_summary relied on the model in exactly the same way, so it
// gets the same cover.
//
// The product tools record what they found as the specific match: the one
// variation get_product matched exactly (otherwise the product itself), and a
// product code's hit. A search's results are not recorded; whichever the model
// then reads in detail is. The newest goes last and a repeat moves to the end,
// so the newest and most specific wins. Only what the tools returned can be
// recorded, so nothing the model makes up can reach an email this way.
//
// Copied from the chat assistant (modules/ai-agent-for-live-chat/lib/
// discussed-products.ts) and kept in step by hand, without the page addresses
// a chat needs: the two modules never import each other.
//
// Pure: the saving is lib/calls.ts saveDiscussedProducts.
// ---------------------------------------------------------------------------

/** Products a call remembers, at most. */
export const MAX_DISCUSSED_PRODUCTS = 10

export type DiscussedProduct = {
  /** The product's or variation's own id, as the tools returned it. */
  id: string
  /** For a variation, its listing's id: a later call naming the listing means
   *  this variation. Null for a product. */
  parentId: string | null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** The stored list, as Postgres hands back JSONB. Anything that is not an
 *  entry with an id is dropped, and a repeated id keeps only its newest place. */
export function parseDiscussedProducts(value: unknown): DiscussedProduct[] {
  if (!Array.isArray(value)) return []
  const entries: DiscussedProduct[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, unknown>
    const id = text(record.id)
    if (!id) continue
    entries.push({ id, parentId: text(record.parentId) })
  }
  return rememberProducts([], entries)
}

/** The list with `found` added at the end: a product already there moves to
 *  the end, a variation replaces its own listing, a listing read again after
 *  one of its variations was chosen brings that variation to the end instead,
 *  and only the newest MAX_DISCUSSED_PRODUCTS are kept. */
export function rememberProducts(list: readonly DiscussedProduct[], found: readonly DiscussedProduct[]): DiscussedProduct[] {
  let out = [...list]
  for (const entry of found) {
    const chosen = entry.parentId === null ? [...out].reverse().find((kept) => kept.parentId === entry.id) : undefined
    const newest = chosen ?? entry
    out = out.filter((kept) => kept.id !== newest.id && kept.id !== newest.parentId)
    out.push(newest)
  }
  return out.slice(-MAX_DISCUSSED_PRODUCTS)
}

/** What get_product found: the one variation that matched exactly, else the
 *  product itself. */
export function fromProductDetail(detail: { id: string; matchingVariations: ReadonlyArray<{ id: string }> | null }): DiscussedProduct[] {
  const variations = detail.matchingVariations ?? []
  const only = variations.length === 1 ? variations[0] : undefined
  if (only) return [{ id: only.id, parentId: detail.id }]
  return [{ id: detail.id, parentId: null }]
}

/** What find_by_sku found: the code's one hit, or its one exact hit among
 *  close ones. Several equally good hits are not a match, so none is kept. */
export function fromSkuHits(hits: ReadonlyArray<{ productId: string; match: 'exact' | 'close'; variation: { id: string } | null }>): DiscussedProduct[] {
  const exact = hits.filter((hit) => hit.match === 'exact')
  const hit = hits.length === 1 ? hits[0] : exact.length === 1 ? exact[0] : undefined
  if (!hit) return []
  return hit.variation ? [{ id: hit.variation.id, parentId: hit.productId }] : [{ id: hit.productId, parentId: null }]
}

/**
 * The products to list in an email: the ids the model passed when it passed
 * any, else the call's own record, newest first. A listing the model names
 * whose variation the call settled on becomes that variation. Repeats go and
 * at most `max` come back. Pure.
 */
export function productsToSend(given: readonly string[], recorded: readonly DiscussedProduct[], max: number): string[] {
  const chosen = new Map(recorded.filter((entry) => entry.parentId).map((entry) => [entry.parentId as string, entry.id]))
  const wanted = given.length > 0
    ? given.map((id) => id.trim()).filter(Boolean).map((id) => chosen.get(id) ?? id)
    : [...recorded].reverse().map((entry) => entry.id)
  return [...new Set(wanted)].slice(0, Math.max(0, max))
}

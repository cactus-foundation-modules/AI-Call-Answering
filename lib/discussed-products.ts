// Copied from the chat assistant (modules/ai-agent-for-live-chat/lib/discussed-products.ts) and
// kept in step by hand: the two modules never import each other. On a call
// nothing is "shown", so markLinked is not used; the rest is the same record.
import { withDeliveryParam } from './product-links'
import { parsePicksRef } from './partial-choice'

// ---------------------------------------------------------------------------
// The products a chat has actually been about, kept on the chat
// (aichat_conversations.discussed_products) so a note or a text sent later can
// list them even when the model forgets to say which.
//
// Learned on a live site: the assistant looked one desk up three times, the
// last time with every option chosen, then emailed a note of the chat with no
// products in it at all, because it never passed product_ids. The email was
// right to list only what it was given; what it was given was nothing.
//
// So the product tools record what they found as the specific match: the one
// variation get_product matched exactly (otherwise the product itself), and a
// product code's hit. A search's results are not recorded, since a list of six
// is not "what we talked about"; whichever the model then reads in detail is.
// The newest goes last and a repeat moves to the end, so the newest and most
// specific wins. Only what the tools returned can be recorded, so nothing the
// model makes up can reach an email or a text this way.
//
// The delivery service the visitor chose for a product (choose_delivery) is
// kept on its entry too, by the shop's own key and name, so the product's
// address can carry it (Live Chat then draws it on the card), the note prints
// it under the product, a text's link carries it and a quote line is saved
// with it. Rows saved before this was added simply have none, and read as
// they always did. Only a key the shop offered for that product is ever
// recorded (lib/shop/delivery-choice.ts), and the card, the note and the
// quote each ask the shop again, so a service since withdrawn quietly drops
// off them.
//
// What the assistant actually SHOWED counts most. Learned on a live chat: asked
// to "email me all the products we chatted about", it emailed a chair it had
// only mentioned to say it was out of stock (and the visitor had moved on
// from), left out the filing cabinet it had linked (a search result, so never
// recorded) and sent the desk without the options chosen. So every product
// address in a reply the assistant sends is matched against what the tools
// returned that turn and the chat's record (markLinked): those entries are
// marked `linked` and added if missing, and when a note or a text is sent
// without naming products, the linked ones are what goes. Each entry keeps its
// name too, so a text can say what each link is.
//
// Pure: the saving is lib/order-state.ts saveDiscussedProducts.
// ---------------------------------------------------------------------------

/** Products a chat remembers, at most. */
export const MAX_DISCUSSED_PRODUCTS = 10

export type DiscussedProduct = {
  /** The product's or variation's own id, as the tools returned it. */
  id: string
  /** Its page address as the tools built it (a variation's with its options),
   *  or null when the site has none. */
  url: string | null
  /** For a variation, its listing's id: a later call naming the listing means
   *  this variation. Null for a product. */
  parentId: string | null
  /** The delivery service the visitor chose for it: the shop's key for it
   *  (`express`) and its name as the shop gives it. Absent when none was. */
  delivery?: ChosenDelivery
  /** The product's name as the shop gives it, for a text's link. */
  name?: string
  /** True once the assistant has shown it (its address in a reply). */
  linked?: boolean
  /** True once it has gone out in an email from this chat. */
  emailed?: boolean
  /** For a listing where the visitor chose only some options: those options,
   *  in the Unified Inbox's spelling (lib/shop/partial-choice.ts). `url` then
   *  picks just those. Absent everywhere else. */
  picks?: string
}

export type ChosenDelivery = { key: string; label: string }

/** The shape of a service key, as Live Chat and the unified inbox accept one. */
const DELIVERY_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/

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
    const delivery = parseDelivery(record.delivery)
    const name = text(record.name)
    const picks = parsePicksRef(record.picks)
    entries.push({
      id,
      url: text(record.url),
      parentId: text(record.parentId),
      ...(delivery ? { delivery } : {}),
      ...(name ? { name: name.slice(0, 200) } : {}),
      ...(record.linked === true ? { linked: true } : {}),
      ...(record.emailed === true ? { emailed: true } : {}),
      ...(picks && text(record.parentId) === null ? { picks } : {}),
    })
  }
  return rememberProducts([], entries)
}

/** A stored delivery choice, or null for anything that is not one. */
function parseDelivery(value: unknown): ChosenDelivery | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const key = text(record.key)
  const label = text(record.label)
  return key && label && DELIVERY_KEY.test(key) ? { key, label } : null
}

/** The list with `found` added at the end: a product already there moves to
 *  the end (keeping the newest address and the delivery chosen for it), a
 *  variation replaces its own listing, a listing read again after one of its
 *  variations was chosen brings that variation to the end instead, and only
 *  the newest MAX_DISCUSSED_PRODUCTS are kept. A listing's delivery is not
 *  handed to its variation: the services can differ, and the choice is made
 *  again for what was chosen. */
export function rememberProducts(list: readonly DiscussedProduct[], found: readonly DiscussedProduct[]): DiscussedProduct[] {
  let out = [...list]
  for (const entry of found) {
    // A listing read again without a new choice keeps the choice made for it:
    // the variation chosen, or the options chosen. A NEW partial choice (picks)
    // replaces whatever was chosen before, because it is what they asked for
    // now ("I only wanted the yellow selected").
    const same = out.find((kept) => kept.id === entry.id)
    const chosen = entry.parentId === null && !entry.picks
      ? [...out].reverse().find((kept) => kept.parentId === entry.id) ?? (same?.picks ? same : undefined)
      : undefined
    // A variation chosen for a listing already shown is what was shown.
    const parent = entry.parentId ? out.find((kept) => kept.id === entry.parentId) : undefined
    const delivery = entry.delivery ?? same?.delivery
    const name = entry.name ?? same?.name ?? parent?.name
    // A partial choice replacing a variation of its own listing that was shown
    // is still the product that was shown.
    const replaced = entry.picks ? out.some((kept) => kept.parentId === entry.id && kept.linked) : false
    const linked = entry.linked === true || same?.linked === true || parent?.linked === true || replaced
    const emailed = entry.emailed === true || same?.emailed === true
    const fresh: DiscussedProduct = {
      ...entry,
      ...(emailed ? { emailed: true } : {}),
      ...(delivery ? { delivery } : {}),
      ...(name ? { name } : {}),
      ...(linked ? { linked: true } : {}),
    }
    const newest = chosen ? { ...chosen, ...(linked ? { linked: true } : {}) } : fresh
    out = out.filter((kept) => kept.id !== newest.id && kept.id !== newest.parentId && !(newest.picks && kept.parentId === newest.id))
    out.push(newest)
  }
  return out.slice(-MAX_DISCUSSED_PRODUCTS)
}

/** A page address reduced to what two spellings of it share: no scheme, no
 *  "www.", no trailing slash, the delivery service and tracking left off and
 *  the options in a fixed order. Pure. */
export function addressKey(address: string): string | null {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  const params = [...url.searchParams.entries()]
    .filter(([key]) => key !== 'delivery-service' && !key.startsWith('utm_'))
    .map(([key, value]) => `${key.toLowerCase()}=${value.toLowerCase()}`)
    .sort()
  return `${url.hostname.replace(/^www\./, '').toLowerCase()}${url.pathname.replace(/\/+$/, '').toLowerCase()}${params.length > 0 ? `?${params.join('&')}` : ''}`
}

/** Web addresses written in a reply, as keys. */
function addressesIn(reply: string): Set<string> {
  const keys = new Set<string>()
  for (const match of reply.matchAll(/https?:\/\/[^\s<>()"']+/g)) {
    const key = addressKey(match[0].replace(/[.,;:!?]+$/, ''))
    if (key) keys.add(key)
  }
  return keys
}

/**
 * The record after a reply: every entry whose address the reply shows, from
 * what the tools returned this turn (`shown`) or already recorded, is marked
 * linked and moved to the end as the newest; nothing else changes. A reply
 * that shows nothing returns the list as it was. Pure.
 */
export function markLinked(list: readonly DiscussedProduct[], shown: readonly DiscussedProduct[], reply: string): DiscussedProduct[] {
  const keys = addressesIn(reply)
  if (keys.size === 0) return [...list]
  const hit = (entry: DiscussedProduct) => {
    const key = entry.url ? addressKey(entry.url) : null
    return key !== null && keys.has(key)
  }
  const found = new Map<string, DiscussedProduct>()
  for (const entry of [...shown, ...list]) {
    if (hit(entry) && !found.has(entry.id)) found.set(entry.id, { ...entry, linked: true })
  }
  if (found.size === 0) return [...list]
  return rememberProducts(list, [...found.values()])
}

/** The entry a product id means in this chat: the product itself, or for a
 *  listing whose variation the chat settled on, that variation (the newest).
 *  Undefined when the chat has not looked it up. Pure. */
export function recordedEntry(list: readonly DiscussedProduct[], id: string): DiscussedProduct | undefined {
  const wanted = id.trim()
  if (!wanted) return undefined
  return list.find((entry) => entry.id === wanted) ?? [...list].reverse().find((entry) => entry.parentId === wanted)
}

/** The list with `delivery` recorded on the entry `id` names (replacing any
 *  earlier choice for it), moved to the end as the newest. A list without that
 *  entry comes back as it was. Pure. */
export function chooseDelivery(list: readonly DiscussedProduct[], id: string, delivery: ChosenDelivery): DiscussedProduct[] {
  const entry = list.find((kept) => kept.id === id)
  if (!entry) return [...list]
  return [...list.filter((kept) => kept.id !== id), { ...entry, delivery: { key: delivery.key, label: delivery.label } }]
}

/** An entry's page address, carrying its chosen delivery service when it has
 *  one, as the model should show it. Pure. */
export function addressOf(entry: Pick<DiscussedProduct, 'url' | 'delivery'>): string | null {
  return withDeliveryParam(entry.url, entry.delivery?.key)
}

/** A product address the tools are about to hand the model, with the delivery
 *  the chat chose for that exact product or variation on it. Pure. */
export function addressWithChoice(id: string, url: string | null, list: readonly DiscussedProduct[]): string | null {
  const delivery = list.find((entry) => entry.id === id)?.delivery
  return withDeliveryParam(url, delivery?.key)
}

/** The delivery chosen for each product id the chat recorded one for. Pure. */
export function chosenDeliveries(list: readonly DiscussedProduct[]): Map<string, ChosenDelivery> {
  return new Map(list.flatMap((entry) => (entry.delivery ? [[entry.id, entry.delivery] as const] : [])))
}

/** What get_product found, as the shapes the tool hands the model: the one
 *  variation that matched exactly, else the product itself. */
export function fromProductDetail(detail: {
  id: string
  name: string
  url: string | null
  matchingVariations: ReadonlyArray<{ id: string; url: string | null }> | null
  chosenOptions?: { url: string | null; picks: string | null } | null
}): DiscussedProduct[] {
  const variations = detail.matchingVariations ?? []
  const only = variations.length === 1 ? variations[0] : undefined
  if (only) return [{ id: only.id, url: only.url, parentId: detail.id, name: detail.name }]
  const partial = detail.chosenOptions
  if (partial?.picks) return [{ id: detail.id, url: partial.url ?? detail.url, parentId: null, name: detail.name, picks: partial.picks }]
  return [{ id: detail.id, url: detail.url, parentId: null, name: detail.name }]
}

/** Every address a product tool handed the model, as entries that can be
 *  marked linked once a reply shows one: the product, and each variation
 *  with its own address. Not recorded until then. Pure. */
export function shownByTool(products: ReadonlyArray<{
  id: string
  name: string
  url: string | null
  variations?: ReadonlyArray<{ id: string; url: string | null }> | null
  /** A partial choice the tool offered: the listing with only some options. */
  partial?: { url: string | null; picks: string | null } | null
}>): DiscussedProduct[] {
  return products.flatMap((product) => [
    { id: product.id, url: product.url, parentId: null, name: product.name },
    ...(product.partial?.picks && product.partial.url
      ? [{ id: product.id, url: product.partial.url, parentId: null, name: product.name, picks: product.partial.picks }]
      : []),
    ...(product.variations ?? []).filter((variation) => variation.id !== product.id)
      .map((variation) => ({ id: variation.id, url: variation.url, parentId: product.id, name: product.name })),
  ])
}

/** The partial choice recorded for each listing, by its id. Pure. */
export function chosenPicks(list: readonly DiscussedProduct[]): Map<string, string> {
  return new Map(list.flatMap((entry) => (entry.picks ? [[entry.id, entry.picks] as const] : [])))
}

/** What find_by_sku found: the code's one hit, or its one exact hit among
 *  close ones. Several equally good hits are not a match, so none is kept. */
export function fromSkuHits(hits: ReadonlyArray<{
  productId: string
  name: string
  url: string | null
  match: 'exact' | 'close'
  variation: { id: string } | null
}>): DiscussedProduct[] {
  const exact = hits.filter((hit) => hit.match === 'exact')
  const hit = hits.length === 1 ? hits[0] : exact.length === 1 ? exact[0] : undefined
  if (!hit) return []
  return hit.variation
    ? [{ id: hit.variation.id, url: hit.url, parentId: hit.productId, name: hit.name }]
    : [{ id: hit.productId, url: hit.url, parentId: null, name: hit.name }]
}

/** The record a note or text falls back on when the model names no product,
 *  newest first: what the assistant showed, when it showed anything, else
 *  everything. */
function fallbackPool(recorded: readonly DiscussedProduct[]): DiscussedProduct[] {
  const linked = recorded.filter((entry) => entry.linked)
  return (linked.length > 0 ? linked : [...recorded]).reverse()
}

/**
 * The products to list in an email or a text: the ids the model passed when it
 * passed any, else the chat's own record (what the assistant showed, when it
 * showed anything), newest first. A
 * listing the model names whose variation the chat settled on becomes that
 * variation, so the email is for what was chosen. Repeats go and at most `max`
 * come back. Pure.
 */
export function productsToSend(given: readonly string[], recorded: readonly DiscussedProduct[], max: number): string[] {
  const chosen = new Map(recorded.filter((entry) => entry.parentId).map((entry) => [entry.parentId as string, entry.id]))
  const wanted = given.length > 0
    ? given.map((id) => id.trim()).filter(Boolean).map((id) => chosen.get(id) ?? id)
    : fallbackPool(recorded).map((entry) => entry.id)
  return [...new Set(wanted)].slice(0, Math.max(0, max))
}

export type TextLink = { label: string | null; url: string }

/** The links for a text: only products the chat recorded (whose addresses the
 *  tools built), the ones named when any are, else what the assistant showed,
 *  each with its name and carrying the delivery chosen for it. Pure. */
export function productLinksToSend(given: readonly string[], recorded: readonly DiscussedProduct[], max: number): TextLink[] {
  const byId = new Map(recorded.map((entry) => [entry.id, entry]))
  const named = productsToSend(given, recorded, recorded.length + given.length)
    .map((id) => byId.get(id))
    .filter((entry): entry is DiscussedProduct => !!entry)
  const pool = named.length > 0 ? named : fallbackPool(recorded)
  const seen = new Set<string>()
  const out: TextLink[] = []
  for (const entry of pool) {
    const url = addressOf(entry)
    if (!url || seen.has(url)) continue
    seen.add(url)
    out.push({ label: entry.name ?? null, url })
  }
  return out.slice(0, Math.max(0, max))
}

/** The list with these ids marked as emailed. Nothing else changes. Pure. */
export function markEmailed(list: readonly DiscussedProduct[], ids: readonly string[]): DiscussedProduct[] {
  const sent = new Set(ids)
  return list.map((entry) => (sent.has(entry.id) ? { ...entry, emailed: true } : entry))
}

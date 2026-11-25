import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrl } from '@/lib/config/env'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { orderTrackingUrl } from '@/modules/shop/lib/order-tracking'
import { productUrl } from '@/modules/shop/lib/product-url'
import type { CallRecord } from './calls'
import { pickOrderForLink } from './order-link'
import {
  basketLinkFor,
  checkBasketLines,
  getCallBasket,
  normaliseBasketItems,
  requestedServices,
  saveCallBasket,
  type BasketItemInput,
  type BasketLine,
  type CheckedLine,
} from './phone-basket'
import { basketServiceMenus, matchService, serviceMissMessage } from './delivery-choice'
import { quotesAvailable } from './quote-saver'
import { getSettings } from './settings'
import { composeText, textCaller, textSignOff, type TextLinkLine } from './sms'
import { productLinksToSend } from './discussed-products'
import { sendableLinks } from './site-content'
import { pickLinks, unknownLinksMessage } from './site-links'

/** A text holds three links at most: past that the note has no room. */
export const MAX_TEXT_LINKS = 3

// The handlers behind build_basket and send_text. Every answer is words the
// model can say or act on, never an error code (see tool-handlers.ts).

type Result = Record<string, unknown>

export async function buildBasket(call: CallRecord, items: BasketItemInput[]): Promise<Result> {
  const lines = normaliseBasketItems(items)
  if (lines.length === 0) {
    return { ok: false, message: 'There was nothing to put in the basket. Pass every line with its product or variation id and quantity.' }
  }
  const checked = await checkBasketLines(lines)
  if (checked.needsOptions.length > 0) {
    return {
      ok: false,
      needsOptions: checked.needsOptions,
      message: 'These are whole listings with options. Call get_product with the options the caller chose, and use the id from matchingVariations instead. Nothing was saved yet.',
    }
  }
  if (checked.lines.length === 0) {
    return { ok: false, message: 'None of those are products the shop sells right now. Search again.' }
  }
  const { lines: saved, misses } = await withServices(checked.lines, requestedServices(items))
  await saveCallBasket(call.id, saved)
  const quotes = await quotesAvailable()
  const deliveryById = new Map(saved.map((line) => [line.productId, line.delivery ?? null]))
  return {
    ok: true,
    lines: checked.lines.map((line) => ({
      name: line.name,
      options: line.options,
      quantity: line.quantity,
      delivery: deliveryById.get(line.productId) ?? null,
    })),
    lineCount: checked.lines.length,
    quotesAvailable: quotes,
    ...(checked.unknown.length > 0 ? { skipped: checked.unknown.length } : {}),
    message: [
      `The basket is saved with ${checked.lines.length} line${checked.lines.length === 1 ? '' : 's'}.`,
      checked.unknown.length > 0 ? `${checked.unknown.length} id(s) were not products on sale and were left out: tell the caller which item could not be added.` : '',
      saved.some((line) => line.delivery) ? 'Each line\'s delivery is the service it is set to: the link, any quote saved from it and checkout all open with that service chosen, so the caller does not need to pick it again.' : '',
      ...misses,
      quotes
        ? 'This shop saves baskets as quotes. Once the list is complete, offer to email it to them as a quote: ask for their full name and email address, read the email back one character at a time, and once they confirm call save_quote. The quote is emailed by the shop, so do not email it yourself.'
        : 'When the list is complete, offer to text them the link (send_text with what "basket") or email it (email_summary carries the link). Ask which first; send nothing they have not agreed to.',
      'Prices, delivery and the total are worked out on the basket page, so quote only totals you already got from get_product.',
      quotes
        ? 'If they add or change anything, call build_basket again with the WHOLE list before saving the quote.'
        : 'If they add or change anything later, call build_basket again with the WHOLE list: a link already sent opens the new version.',
    ].filter(Boolean).join(' '),
  }
}

/** The basket lines with the delivery service each caller asked for written
 *  on, where the shop offers it for that line, plus a sentence for each one that
 *  could not be set. A line nobody chose a service for is left exactly as it was,
 *  so the shop's default applies as for any other basket. */
async function withServices(
  lines: CheckedLine[],
  asked: Map<string, string>,
): Promise<{ lines: BasketLine[]; misses: string[] }> {
  const plain = (line: CheckedLine): BasketLine => ({ productId: line.productId, quantity: line.quantity })
  if (asked.size === 0) return { lines: lines.map(plain), misses: [] }
  const menus = await basketServiceMenus([...asked.keys()])
  const misses: string[] = []
  const out = lines.map((line): BasketLine => {
    const said = asked.get(line.productId)
    if (!said) return plain(line)
    const menu = menus.get(line.productId)
    const match = menu ? matchService(said, menu.options) : null
    if (!menu || !match || match.kind !== 'match') {
      misses.push(serviceMissMessage(line.name, said, match))
      return plain(line)
    }
    return { ...plain(line), meta: { [menu.field]: match.option.key }, delivery: match.option.label }
  })
  return { lines: out, misses }
}

async function productLinks(ids: string[]): Promise<string[]> {
  const wanted = [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 3)
  if (wanted.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ id: string; slug: string | null }>>(Prisma.sql`
    SELECT "id", "slug" FROM "shp_products" WHERE "id" IN (${Prisma.join(wanted)}) AND "status" = 'ACTIVE'
  `)
  const config = await getShopConfigCached()
  const site = getSiteUrl()
  const bySlug = new Map(rows.map((row) => [row.id, row.slug]))
  return wanted.flatMap((id) => {
    const slug = bySlug.get(id)
    return slug ? [productUrl(site, slug, config.productUrlStyle)] : []
  })
}

export type TextKind = 'basket' | 'order_link' | 'summary'

export async function sendText(
  call: CallRecord,
  input: { what: TextKind; note: string | null; productIds: string[]; linkIds: string[]; orderNumber: string | null },
): Promise<Result> {
  const settings = await getSettings()
  const signOff = textSignOff(settings.businessName, getSiteUrl())
  let body: string
  let leftOut = ''
  if (input.what === 'basket') {
    const basket = await getCallBasket(call.id)
    if (!basket || basket.lines.length === 0) {
      return { ok: false, message: 'There is no basket on this call yet. Build it first with build_basket.' }
    }
    // Once saved as a quote, the text carries the quote's link, which opens the
    // same basket: one thing for the caller to keep, not two.
    const fallback = basket.quote
      ? `Here is quote ${basket.quote.number}, from our call. Open it to see prices and delivery and check out.`
      : 'Here is the basket we put together on the phone. Open it to see prices and delivery and check out.'
    body = composeText(input.note || fallback, [{ label: null, url: basketLinkFor(basket) }], signOff)
  } else if (input.what === 'order_link') {
    if (call.verifiedOrders.length === 0) {
      return { ok: false, message: 'No order has been checked on this call yet. Check the order first.' }
    }
    const orderNumber = pickOrderForLink(call.verifiedOrders, input.orderNumber)
    if (!orderNumber) return { ok: false, message: 'Which order do they mean? Ask, then try again with order_number.' }
    const url = orderTrackingUrl(orderNumber, await getShopConfigCached())
    if (!url) return { ok: false, message: 'Order links are not switched on for this shop. Offer a callback instead.' }
    body = composeText(`Here is the page for your order ${orderNumber}, where you can track it and report a problem.`, [{ label: null, url }], signOff)
  } else {
    const note = (input.note ?? '').trim()
    if (!note) return { ok: false, message: 'Write a short note of what was discussed and retry.' }
    // The page or article they asked for comes first; products fill what room is left.
    const picked = input.linkIds.length > 0
      ? pickLinks(input.linkIds, await sendableLinks(settings.extraInstructions), MAX_TEXT_LINKS)
      : { links: [], unknown: 0 }
    if (input.linkIds.length > 0 && picked.links.length === 0) {
      return { ok: false, message: `Nothing was sent. ${unknownLinksMessage(picked.unknown)} If you cannot find it, tell the caller where it is on the website instead.` }
    }
    leftOut = unknownLinksMessage(picked.unknown)
    // Products from the call's own record (named, with the options chosen,
    // or only some of them); an id it never recorded is linked as a page.
    const recorded = productLinksToSend(input.productIds, call.discussedProducts, MAX_TEXT_LINKS)
    const productLines: TextLinkLine[] = recorded.length > 0
      ? recorded
      : (await productLinks(input.productIds)).map((url) => ({ label: null, url }))
    const links: TextLinkLine[] = []
    for (const link of [...picked.links.map((page) => ({ label: page.label, url: page.url })), ...productLines]) {
      if (!links.some((kept) => kept.url === link.url)) links.push(link)
    }
    links.splice(MAX_TEXT_LINKS)
    body = composeText(note, links, signOff)
  }
  const sent = await textCaller(call, body)
  if (!sent.ok) return sent
  return { ok: true, message: ['Texted to the number they are calling from. Tell them it is on its way. Do not read the number out.', leftOut].filter(Boolean).join(' ') }
}

/** The line added to a summary email when the call has a basket, so a caller
 *  on a landline still gets the link. Null when there is none. */
export async function basketLinkForEmail(call: CallRecord): Promise<string | null> {
  const basket = await getCallBasket(call.id)
  return basket && basket.lines.length > 0 ? basketLinkFor(basket) : null
}

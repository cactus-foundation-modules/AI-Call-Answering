import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getSiteUrl } from '@/lib/config/env'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { orderTrackingUrl } from '@/modules/shop/lib/order-tracking'
import { productUrl } from '@/modules/shop/lib/product-url'
import type { CallRecord } from './calls'
import { pickOrderForLink } from './order-link'
import {
  basketUrl,
  checkBasketLines,
  getCallBasket,
  normaliseBasketItems,
  saveCallBasket,
  type BasketItemInput,
} from './phone-basket'
import { getSettings } from './settings'
import { composeText, textCaller } from './sms'

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
  await saveCallBasket(call.id, checked.lines.map(({ productId, quantity }) => ({ productId, quantity })))
  return {
    ok: true,
    lines: checked.lines.map((line) => ({ name: line.name, options: line.options, quantity: line.quantity })),
    lineCount: checked.lines.length,
    ...(checked.unknown.length > 0 ? { skipped: checked.unknown.length } : {}),
    message: [
      `The basket is saved with ${checked.lines.length} line${checked.lines.length === 1 ? '' : 's'}.`,
      checked.unknown.length > 0 ? `${checked.unknown.length} id(s) were not products on sale and were left out: tell the caller which item could not be added.` : '',
      'Offer to text them the link (send_text with what "basket"). Prices, delivery and the total are worked out on the basket page, so quote only totals you already got from get_product.',
      'If they add or change anything later, call build_basket again with the WHOLE list: a link already sent opens the new version.',
    ].filter(Boolean).join(' '),
  }
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
  input: { what: TextKind; note: string | null; productIds: string[]; orderNumber: string | null },
): Promise<Result> {
  const settings = await getSettings()
  const signOff = settings.businessName.trim()
  let body: string
  if (input.what === 'basket') {
    const basket = await getCallBasket(call.id)
    if (!basket || basket.lines.length === 0) {
      return { ok: false, message: 'There is no basket on this call yet. Build it first with build_basket.' }
    }
    body = composeText(input.note || 'Here is the basket we put together on the phone. Open it to see prices and delivery and check out.', [basketUrl(basket.token)], signOff)
  } else if (input.what === 'order_link') {
    if (call.verifiedOrders.length === 0) {
      return { ok: false, message: 'No order has been checked on this call yet. Check the order first.' }
    }
    const orderNumber = pickOrderForLink(call.verifiedOrders, input.orderNumber)
    if (!orderNumber) return { ok: false, message: 'Which order do they mean? Ask, then try again with order_number.' }
    const url = orderTrackingUrl(orderNumber, await getShopConfigCached())
    if (!url) return { ok: false, message: 'Order links are not switched on for this shop. Offer a callback instead.' }
    body = composeText(`Here is the page for your order ${orderNumber}, where you can track it and report a problem.`, [url], signOff)
  } else {
    const note = (input.note ?? '').trim()
    if (!note) return { ok: false, message: 'Write a short note of what was discussed and retry.' }
    body = composeText(note, await productLinks(input.productIds), signOff)
  }
  const sent = await textCaller(call, body)
  if (!sent.ok) return sent
  return { ok: true, message: 'Texted to the number they are calling from. Tell them it is on its way. Do not read the number out.' }
}

/** The line added to a summary email when the call has a basket, so a caller
 *  on a landline still gets the link. Null when there is none. */
export async function basketLinkForEmail(call: CallRecord): Promise<string | null> {
  const basket = await getCallBasket(call.id)
  return basket && basket.lines.length > 0 ? basketUrl(basket.token) : null
}

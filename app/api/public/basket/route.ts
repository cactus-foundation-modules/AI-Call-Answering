import { NextRequest, NextResponse } from 'next/server'
import { getMemberFromCookie } from '@/lib/members/session'
import { getGuestCart, saveGuestCart, GUEST_CART_MAX_LINES } from '@/modules/shop/lib/db/guest-cart'
import { getMemberCart, saveMemberCart, MEMBER_CART_MAX_LINES } from '@/modules/shop/lib/db/member-cart'
import { mintGuestCartId, readGuestCartId, setGuestCartCookie } from '@/modules/shop/lib/guest-cart-cookie'
import { openBasketByToken, type BasketLine } from '@/modules/ai-call-answering/lib/phone-basket'

// GET /api/m/ai-call-answering/public/basket?t=<token>
//
// The link in "here's the basket we put together on the phone". It copies the
// call's lines into this browser's basket and redirects to the basket page, so
// it works on whatever phone or computer the caller opens it on - a text opens
// in a browser that has never seen the shop, let alone the call.
//
// Lines only, and only ever into the basket: the token reveals product names
// and quantities, never who called. Shaped on abandoned-carts-for-shop's
// recover route, which solves the same problem for the same reasons.

export const dynamic = 'force-dynamic'

const BASKET_PATH = '/shop/cart'

/** The phone basket replaces a line already there rather than adding to it:
 *  somebody opening the link twice must not end up with double. Lines already
 *  in the basket that the call did not mention are kept, after the call's. */
function merge(fromCall: BasketLine[], current: Array<BasketLine & Record<string, unknown>>) {
  const called = new Set(fromCall.map((line) => line.productId))
  return [...fromCall.map((line) => ({ ...line })), ...current.filter((line) => !called.has(line.productId))]
}

export async function GET(request: NextRequest) {
  const token = (new URL(request.url).searchParams.get('t') ?? '').trim().slice(0, 100)
  const response = NextResponse.redirect(new URL(BASKET_PATH, request.url), 303)
  // Never cached: the redirect carries a Set-Cookie naming one shopper's basket.
  response.headers.set('Cache-Control', 'no-store')

  const lines = token ? await openBasketByToken(token).catch(() => null) : null
  if (!lines || lines.length === 0) return response

  // A signed-in shopper's basket belongs to their account; the shop never reads
  // the guest row for them.
  const member = await getMemberFromCookie().catch(() => null)
  if (member?.id) {
    const existing = await getMemberCart(member.id).catch(() => null)
    await saveMemberCart(member.id, merge(lines, existing?.lines ?? []).slice(0, MEMBER_CART_MAX_LINES)).catch(() => undefined)
    return response
  }

  const cartId = readGuestCartId(request) ?? mintGuestCartId()
  const existing = await getGuestCart(cartId).catch(() => null)
  const saved = await saveGuestCart(cartId, merge(lines, existing?.lines ?? []).slice(0, GUEST_CART_MAX_LINES)).catch(() => null)
  // Only once the row has landed: a cookie pointing at a basket never written
  // would read as "your basket is empty" and clear the one the browser had.
  if (saved) setGuestCartCookie(response, cartId)
  return response
}

import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getShopConfigCached, type ShpConfig } from '@/modules/shop/lib/config'
import type { ShpOrderStatus } from '@/modules/shop/lib/types'
import { formatPrice } from './product-format'
import { proformaAvailable } from '@/modules/shop/lib/proforma'
import { getPaymentProvider, resolveProviderLabel } from '@/modules/shop/lib/payments/registry'
import { manualPaymentInstructions, paymentOutstanding } from '@/modules/shop/lib/payment-instructions'
import { settlementMethod } from '@/modules/shop/lib/order-pay-online'
import type { ShpPaymentStatus } from '@/modules/shop/lib/types'
import { orderPaperwork, speakableInstructions } from './payment-words'
import {
  claimMatchesOrder,
  orderStatusWords,
  trackingStageWords,
  type OrderClaim,
  type OrderIdentity,
} from './order-verify'
import { getSiteTimezone } from '@/lib/config/timezone.server'
import { parseConsignmentParcels } from '@/modules/shop/lib/consignment-parcels-schema'
import { describeDeliveryMoment, describeParcels, describePlaced, summariseParcels, type ParcelFacts } from './delivery-words'
import type { VerifiedContact } from './calls'
import { normaliseCompany, normaliseOrderNumber, normalisePostcode, phoneMatchKey, postcodeMatchKey, splitOrderNumber } from './text'
import {
  chargeStatusWords,
  describeRequest,
  distinctEmails,
  lineChoices,
  refundStatusWords,
  type RequestFacts,
} from './order-detail'

// ---------------------------------------------------------------------------
// Looking an order up for a caller who has said who they are.
//
// Two steps, and the order of them is the security: candidates are found by
// whatever identifier the caller gave, then EVERY candidate is checked against
// the full claim in order-verify.ts. Only an order that passes is read in
// detail, and the detail deliberately leaves out email, phone, street address
// and tracking numbers - a caller who has proved the postcode is told the town
// and the progress, not handed the customer record. The one exception is the
// email addresses on the orders, and only when there is more than one: the
// assistant has to read them out so the caller can say where a link goes.
// ---------------------------------------------------------------------------

const CANDIDATE_LIMIT = 25
/** Wider than CANDIDATE_LIMIT: the postcode-neighbourhood net holds many strangers. */
const FUZZY_CANDIDATE_LIMIT = 400
const MAX_ORDERS_RETURNED = 3
/** Orders read for a caller recognised by their number: enough to cover "the one
 *  from January" without turning the answer into a customer history. */
const MAX_CALLER_ORDERS = 5

type CandidateRow = {
  id: string
  order_number: string
  customer_email: string
  customer_organisation: string | null
  shipping_address: unknown
}

function addressField(address: unknown, field: string): string | null {
  if (!address || typeof address !== 'object') return null
  const value = (address as Record<string, unknown>)[field]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

async function findCandidates(claim: OrderClaim): Promise<CandidateRow[]> {
  const columns = Prisma.sql`o."id", o."order_number", o."customer_email", o."customer_organisation", o."shipping_address"`
  const saleOnly = Prisma.sql`o."kind" = 'SALE'`

  if (claim.orderNumber?.trim()) {
    const wanted = normaliseOrderNumber(claim.orderNumber)
    if (wanted === '') return []
    // Also the same number without its prefix or padding zeros (DW000123 for
    // order 123); the prefix rule is applied afterwards in order-verify.ts.
    const bare = splitOrderNumber(claim.orderNumber)?.number ?? wanted
    return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT ${columns} FROM "shp_orders" o
      WHERE ${saleOnly} AND (
        regexp_replace(upper(o."order_number"), '[^A-Z0-9]', '', 'g') = ${wanted}
        OR ltrim(substring(o."order_number" from '([0-9]+)[^0-9]*$'), '0') = ${bare}
      )
      LIMIT ${CANDIDATE_LIMIT}
    `)
  }
  if (claim.email?.trim()) {
    return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT ${columns} FROM "shp_orders" o
      WHERE ${saleOnly} AND lower(o."customer_email") = ${claim.email.trim().toLowerCase()}
      ORDER BY o."created_at" DESC LIMIT ${CANDIDATE_LIMIT}
    `)
  }
  const company = normaliseCompany(claim.companyName ?? '')
  const firstWord = company.split(' ')[0] ?? ''
  if (firstWord.length < 2) return []
  const like = `%${firstWord.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
  return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT ${columns} FROM "shp_orders" o
    WHERE ${saleOnly}
      AND (o."customer_organisation" ILIKE ${like} OR o."shipping_address"->>'company' ILIKE ${like})
    ORDER BY o."created_at" DESC LIMIT ${CANDIDATE_LIMIT}
  `)
}

/** The wider net, cast only when nothing matched exactly: orders whose delivery
 *  postcode shares the start or the end of the one given (a single wrong
 *  character cannot spoil both), for the verifier to judge. Email and company
 *  claims only; an order number is already found by its digits. */
async function findFuzzyCandidates(claim: OrderClaim): Promise<CandidateRow[]> {
  if (claim.orderNumber?.trim()) return []
  const key = postcodeMatchKey(claim.postcode)
  const plain = normalisePostcode(claim.postcode)
  if (key.length < 6 || plain.length < 6) return []
  const held = Prisma.sql`regexp_replace(upper(o."shipping_address"->>'postcode'), '[^A-Z0-9]', '', 'g')`
  return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
    SELECT o."id", o."order_number", o."customer_email", o."customer_organisation", o."shipping_address"
    FROM "shp_orders" o
    WHERE o."kind" = 'SALE'
      AND (left(${held}, 2) = ${plain.slice(0, 2)} OR right(${held}, 3) = ${plain.slice(-3)}
           OR left(${held}, 2) = ${key.slice(0, 2)} OR right(${held}, 3) = ${key.slice(-3)})
    ORDER BY o."created_at" DESC LIMIT ${FUZZY_CANDIDATE_LIMIT}
  `)
}

function identityOf(row: CandidateRow): OrderIdentity {
  return {
    orderNumber: row.order_number,
    customerEmail: row.customer_email,
    customerOrganisation: row.customer_organisation,
    shippingPostcode: addressField(row.shipping_address, 'postcode'),
    shippingCompany: addressField(row.shipping_address, 'company'),
  }
}

export type VerifiedOrder = {
  orderNumber: string
  placed: string
  /** When it was placed in words a caller recognises, for telling orders apart
   *  without an order number: "today", "yesterday", "on the 14th of January". */
  placedWords: string
  /** Month and year, for "is it the one from January". */
  placedMonth: string
  status: string
  payment: string
  total: string
  deliveringTo: string | null
  /** Money in words, as the order records it. Null where there is none. */
  breakdown: {
    subtotal: string
    discount: string | null
    couponCode: string | null
    delivery: string | null
    deliveryService: string | null
    tax: string | null
    paymentMethod: string | null
  }
  deliveryInstructions: string | null
  customerReference: string | null
  items: Array<{
    name: string
    quantity: number
    sku: string | null
    unitPrice: string
    lineTotal: string
    /** What was chosen on the line (colour, size, delivery option). */
    choices: string[]
    refundedQuantity: number
    preOrderDispatch: string | null
    returnable: boolean
    notReturnableBecause: string | null
  }>
  refunds: Array<{ amount: string; status: string; date: string }>
  requests: RequestFacts[]
  /** Extra charges raised on the order after it was placed. */
  extraCharges: Array<{ reason: string; total: string; status: string }>
  /** Notes the team left that the customer can see, newest first. */
  notesFromTeam: Array<{ date: string; text: string }>
  invoiceAvailable: boolean
  /** Whether the caller has a pro-forma invoice for it (a bank transfer order,
   *  say). Not a VAT invoice. */
  proformaAvailable: boolean
  /** What to tell the caller about the order's VAT invoice and pro-forma. */
  paperwork: string
  /** Where to send the money (bank details for a transfer), while this order
   *  still owes it on a method settled by hand. Null otherwise. */
  howToPay: string | null
  deliveries: Array<{
    carrier: string | null
    dispatched: string
    progress: string | null
    expectedDelivery: string | null
    /** When the courier handed it over, day and time. For a delivery made up of
     *  several parcels this is left null: each parcel has its own in `parcels`. */
    deliveredOn: string | null
    /** Present only for a delivery the courier split into several parcels. */
    parcels: ParcelFacts[] | null
    parcelSummary: string | null
    /** A delay the courier or the team has flagged, in words. */
    delay: string | null
    signedBy: string | null
    outForDelivery: boolean
    stopsAway: number | null
    minutesAway: number | null
  }>
}

export type OrderLookupOutcome =
  | {
      matched: true
      orders: VerifiedOrder[]
      internalNumbers: string[]
      contact: VerifiedContact | null
      /** Every distinct address on the matched orders. */
      emails: string[]
    }
  | { matched: false }

type OrderRow = {
  id: string
  order_number: string
  status: ShpOrderStatus
  payment_status: string
  created_at: Date
  total: unknown
  subtotal: unknown
  discount_amount: unknown
  shipping_amount: unknown
  tax_amount: unknown
  coupon_code: string | null
  payment_method: string | null
  original_payment_method: string | null
  shipping_rate_name: string | null
  delivery_instructions: string | null
  customer_reference: string | null
  currency: string
  shipping_address: unknown
  customer_name: string | null
  customer_email: string
  customer_phone: string | null
}

type ItemRow = {
  order_id: string
  product_name: string
  quantity: number
  product_sku: string | null
  unit_price: unknown
  total: unknown
  refunded_qty: number
  is_pre_order: boolean
  pre_order_dispatch_date: Date | null
  line_meta: unknown
  returnable: boolean
  non_returnable_note: string | null
}

type RefundRow = { order_id: string; amount: unknown; status: string; created_at: Date }
type RequestRow = { order_id: string; type: string; status: string; created_at: Date }
type ChargeRow = { order_id: string; reason: string; total: unknown; status: string }
type NoteRow = { order_id: string; content: string; created_at: Date }

type ShipmentRow = {
  order_id: string
  carrier: string | null
  shipped_at: Date
  tracking_stage: string | null
  delivery_date: string | null
  delivery_slot_start: string | null
  delivery_slot_end: string | null
  delivered_at: Date | null
  consignment_parcels: unknown
  delivery_delay: string | null
  delivery_delay_note: string | null
  signed_by: string | null
  carrier_out_for_delivery: boolean | null
  drops_away: number | null
  minutes_to_stop: number | null
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/** Whether any shipment of this order has a real delivery date (or has been
 *  delivered), which makes the estimate printed on its lines redundant. */
function hasCourierDate(orderId: string, shipments: readonly ShipmentRow[]): boolean {
  return shipments.some((shipment) => shipment.order_id === orderId && (!!shipment.delivery_date || !!shipment.delivered_at))
}

function expected(row: ShipmentRow): string | null {
  if (!row.delivery_date) return null
  return row.delivery_slot_start && row.delivery_slot_end
    ? `${row.delivery_date}, between ${row.delivery_slot_start} and ${row.delivery_slot_end}`
    : row.delivery_date
}

/** The contact details of the customer the matched orders belong to, or null
 *  when there are none or the orders disagree about who that is. Kept on the
 *  server: the assistant is told only that details are on file. */
function sharedContact(orders: readonly OrderRow[]): VerifiedContact | null {
  const emails = new Set(orders.map((order) => order.customer_email.trim().toLowerCase()).filter(Boolean))
  const newest = orders[0]
  if (!newest || emails.size !== 1) return null
  return {
    name: newest.customer_name?.trim() ?? '',
    email: newest.customer_email.trim().toLowerCase(),
    phone: newest.customer_phone?.trim() ?? '',
  }
}

export async function lookupOrders(claim: OrderClaim): Promise<OrderLookupOutcome> {
  const matching = (rows: CandidateRow[]) => rows.filter((row) => claimMatchesOrder(claim, identityOf(row)))
  let passed = matching(await findCandidates(claim))
  if (passed.length === 0) passed = matching(await findFuzzyCandidates(claim))
  if (passed.length === 0) return { matched: false }
  return readOrders(passed.slice(0, MAX_ORDERS_RETURNED).map((row) => row.id))
}

/** The orders placed from the number the caller rang from, newest first. This
 *  is the only way in that asks the caller for nothing, so it is deliberately
 *  narrow: the number must be a real one (not withheld), and a match is on the
 *  order's own contact number. Caller ID can be faked, so what comes back is the
 *  same trimmed view as any verified lookup: progress and town, never the
 *  customer record. */
export async function lookupOrdersByCallerNumber(fromNumber: string): Promise<OrderLookupOutcome> {
  const key = phoneMatchKey(fromNumber)
  if (!key) return { matched: false }
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT o."id" FROM "shp_orders" o
    WHERE o."kind" = 'SALE'
      AND (
        right(regexp_replace(coalesce(o."customer_phone", ''), '[^0-9]', '', 'g'), 10) = ${key}
        OR right(regexp_replace(coalesce(o."notify_phone", ''), '[^0-9]', '', 'g'), 10) = ${key}
      )
    ORDER BY o."created_at" DESC LIMIT ${MAX_CALLER_ORDERS}
  `)
  if (rows.length === 0) return { matched: false }
  return readOrders(rows.map((row) => row.id))
}

function money(value: unknown, order: OrderRow, symbol: string): string {
  return formatPrice(Number(value), order.currency === 'GBP' ? symbol : `${order.currency} `)
}

function moneyOrNull(value: unknown, order: OrderRow, symbol: string): string | null {
  return Number(value) > 0 ? money(value, order, symbol) : null
}

function delayWords(row: ShipmentRow): string | null {
  const parts = [row.delivery_delay?.trim(), row.delivery_delay_note?.trim()].filter((part): part is string => !!part)
  return parts.length > 0 ? parts.join(': ') : null
}

/** The email address of each order, for a caller who has verified them. Used
 *  when an email must go to one of the addresses on file. */
export async function emailsOnOrders(orderNumbers: readonly string[]): Promise<string[]> {
  if (orderNumbers.length === 0) return []
  const rows = await prisma.$queryRaw<Array<{ customer_email: string }>>(Prisma.sql`
    SELECT "customer_email" FROM "shp_orders"
    WHERE "kind" = 'SALE' AND "order_number" IN (${Prisma.join([...orderNumbers])})
    ORDER BY "created_at" DESC
  `)
  return distinctEmails(rows.map((row) => row.customer_email))
}

/** The name on the newest order using this address. */
export async function nameOnOrderEmail(orderNumbers: readonly string[], email: string): Promise<string> {
  if (orderNumbers.length === 0) return ''
  const rows = await prisma.$queryRaw<Array<{ customer_name: string | null }>>(Prisma.sql`
    SELECT "customer_name" FROM "shp_orders"
    WHERE "order_number" IN (${Prisma.join([...orderNumbers])}) AND lower("customer_email") = ${email.trim().toLowerCase()}
    ORDER BY "created_at" DESC LIMIT 1
  `)
  return rows[0]?.customer_name?.trim() ?? ''
}

/** Each order's payment method by the name the shop gives it today, as the
 *  checkout and the order page say it. A method no longer installed falls back
 *  to its code in plain words rather than to nothing. */
async function paymentMethodNames(orders: readonly OrderRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(orders.map((order) => order.payment_method).filter((id): id is string => !!id))]
  const names = await Promise.all(ids.map(async (id) => {
    const provider = getPaymentProvider(id)
    return provider ? await resolveProviderLabel(provider) : id.trim().toLowerCase().replace(/_/g, ' ')
  }))
  return new Map(ids.map((id, i) => [id, names[i] ?? id]))
}

/** The words the order page prints under "how to pay" for this order, while it
 *  still prints them: an unpaid order on a method settled by hand, by the
 *  method it was placed with (shop's own rule, so the phone and the page never
 *  disagree). Null once paid, cancelled or refunded. */
function howToPayFor(config: Pick<ShpConfig, 'bankTransferInstructions' | 'cashInstructions'>, order: OrderRow): string | null {
  const payable = {
    status: order.status,
    // Shop's own column, read as text; settlementMethod only asks whether it is a paid one.
    paymentStatus: order.payment_status as ShpPaymentStatus,
    paymentMethod: order.payment_method ?? '',
    originalPaymentMethod: order.original_payment_method,
    total: String(order.total),
  }
  if (!paymentOutstanding(payable)) return null
  const words = manualPaymentInstructions(settlementMethod(payable), config)
  return words ? speakableInstructions(words) : null
}

function proformaFor(config: Pick<ShpConfig, 'proformaEnabled'>, order: OrderRow): boolean {
  return proformaAvailable(config, {
    status: order.status,
    paymentMethod: order.payment_method ?? '',
    originalPaymentMethod: order.original_payment_method,
  })
}

async function readOrders(ids: string[]): Promise<OrderLookupOutcome> {
  const [orders, items, shipments, refunds, requests, charges, notes, invoices, config, timezone] = await Promise.all([
    prisma.$queryRaw<OrderRow[]>(Prisma.sql`
      SELECT o."id", o."order_number", o."status", o."payment_status", o."created_at", o."total", o."subtotal",
             o."discount_amount", o."shipping_amount", o."tax_amount", o."coupon_code", o."payment_method",
             o."original_payment_method", o."shipping_rate_name", o."delivery_instructions", o."customer_reference", o."currency", o."shipping_address",
             o."customer_name", o."customer_email", o."customer_phone"
      FROM "shp_orders" o WHERE o."id" IN (${Prisma.join(ids)}) ORDER BY o."created_at" DESC
    `),
    prisma.$queryRaw<ItemRow[]>(Prisma.sql`
      SELECT "order_id", "product_name", "quantity", "product_sku", "unit_price", "total", "refunded_qty",
             "is_pre_order", "pre_order_dispatch_date", "line_meta", "returnable", "non_returnable_note"
      FROM "shp_order_items" WHERE "order_id" IN (${Prisma.join(ids)})
    `),
    prisma.$queryRaw<ShipmentRow[]>(Prisma.sql`
      SELECT "order_id", "carrier", "shipped_at", "tracking_stage", "delivery_date",
             "delivery_slot_start", "delivery_slot_end", "delivered_at", "consignment_parcels",
             "delivery_delay", "delivery_delay_note", "signed_by", "carrier_out_for_delivery", "drops_away", "minutes_to_stop"
      FROM "shp_shipments" WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "shipped_at"
    `),
    prisma.$queryRaw<RefundRow[]>(Prisma.sql`
      SELECT "order_id", "amount", "status", "created_at" FROM "shp_refunds"
      WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "created_at" DESC
    `),
    prisma.$queryRaw<RequestRow[]>(Prisma.sql`
      SELECT "order_id", "type", "status", "created_at" FROM "shp_order_requests"
      WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "created_at" DESC
    `),
    prisma.$queryRaw<ChargeRow[]>(Prisma.sql`
      SELECT "order_id", "reason", "total", "status" FROM "shp_order_charges"
      WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "created_at" DESC
    `),
    prisma.$queryRaw<NoteRow[]>(Prisma.sql`
      SELECT "order_id", "content", "created_at" FROM "shp_order_notes"
      WHERE "order_id" IN (${Prisma.join(ids)}) AND "is_internal" = false ORDER BY "created_at" DESC LIMIT 20
    `),
    prisma.$queryRaw<Array<{ order_id: string }>>(Prisma.sql`
      SELECT DISTINCT "order_id" FROM "shp_invoices"
      WHERE "order_id" IN (${Prisma.join(ids)}) AND "voided_at" IS NULL AND "superseded_at" IS NULL
    `),
    getShopConfigCached(),
    getSiteTimezone(),
  ])
  const symbol = config.currencySymbol
  const invoiced = new Set(invoices.map((row) => row.order_id))
  const methodNames = await paymentMethodNames(orders)

  const verified: VerifiedOrder[] = orders.map((order) => ({
    orderNumber: order.order_number,
    placed: day(order.created_at),
    placedWords: describePlaced(order.created_at, timezone),
    placedMonth: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: timezone }).format(order.created_at),
    status: orderStatusWords(order.status, order.payment_status),
    payment: order.payment_status.toLowerCase().replace(/_/g, ' '),
    total: money(order.total, order, symbol),
    deliveringTo: addressField(order.shipping_address, 'city'),
    breakdown: {
      subtotal: money(order.subtotal, order, symbol),
      discount: moneyOrNull(order.discount_amount, order, symbol),
      couponCode: order.coupon_code?.trim() || null,
      delivery: Number(order.shipping_amount) > 0 ? money(order.shipping_amount, order, symbol) : 'free',
      deliveryService: order.shipping_rate_name?.trim() || null,
      tax: moneyOrNull(order.tax_amount, order, symbol),
      paymentMethod: order.payment_method ? methodNames.get(order.payment_method) ?? null : null,
    },
    deliveryInstructions: order.delivery_instructions?.trim() || null,
    customerReference: order.customer_reference?.trim() || null,
    items: items
      .filter((item) => item.order_id === order.id)
      .map((item) => ({
        name: item.product_name,
        quantity: item.quantity,
        sku: item.product_sku?.trim() || null,
        unitPrice: money(item.unit_price, order, symbol),
        lineTotal: money(item.total, order, symbol),
        choices: lineChoices(item.line_meta, { dropDeliveryEstimate: hasCourierDate(order.id, shipments) }),
        refundedQuantity: item.refunded_qty,
        preOrderDispatch: item.is_pre_order && item.pre_order_dispatch_date ? day(item.pre_order_dispatch_date) : null,
        returnable: item.returnable,
        notReturnableBecause: item.returnable ? null : item.non_returnable_note?.trim() || null,
      })),
    refunds: refunds
      .filter((refund) => refund.order_id === order.id)
      .map((refund) => ({ amount: money(refund.amount, order, symbol), status: refundStatusWords(refund.status), date: day(refund.created_at) })),
    requests: requests.filter((request) => request.order_id === order.id).map(describeRequest),
    extraCharges: charges
      .filter((charge) => charge.order_id === order.id)
      .map((charge) => ({ reason: charge.reason, total: money(charge.total, order, symbol), status: chargeStatusWords(charge.status) })),
    notesFromTeam: notes
      .filter((note) => note.order_id === order.id)
      .slice(0, 5)
      .map((note) => ({ date: day(note.created_at), text: note.content.trim().slice(0, 500) })),
    invoiceAvailable: invoiced.has(order.id),
    proformaAvailable: proformaFor(config, order),
    paperwork: orderPaperwork(config, {
      invoiced: invoiced.has(order.id),
      proformaAvailable: proformaFor(config, order),
      cancelledOrRefunded: order.status === 'CANCELLED' || order.status === 'REFUNDED',
    }),
    howToPay: howToPayFor(config, order),
    deliveries: shipments
      .filter((shipment) => shipment.order_id === order.id)
      .map((shipment) => {
        const boxes = parseConsignmentParcels(shipment.consignment_parcels)
        const split = boxes !== null && boxes.length > 1
        const parcels = split ? describeParcels(boxes, timezone) : null
        return {
          carrier: shipment.carrier,
          dispatched: day(shipment.shipped_at),
          progress: trackingStageWords(shipment.tracking_stage),
          expectedDelivery: expected(shipment),
          deliveredOn: !split && shipment.delivered_at ? describeDeliveryMoment(shipment.delivered_at, timezone) : null,
          parcels,
          parcelSummary: parcels ? summariseParcels(parcels) : null,
          delay: delayWords(shipment),
          signedBy: shipment.delivered_at && shipment.signed_by?.trim() ? shipment.signed_by.trim() : null,
          outForDelivery: shipment.carrier_out_for_delivery === true && !shipment.delivered_at,
          stopsAway: shipment.carrier_out_for_delivery === true && !shipment.delivered_at ? shipment.drops_away : null,
          minutesAway: shipment.carrier_out_for_delivery === true && !shipment.delivered_at ? shipment.minutes_to_stop : null,
        }
      }),
  }))
  return {
    matched: true,
    orders: verified,
    internalNumbers: verified.map((order) => order.orderNumber),
    contact: sharedContact(orders),
    emails: distinctEmails(orders.map((order) => order.customer_email)),
  }
}

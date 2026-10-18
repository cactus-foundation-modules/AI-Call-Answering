import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db/prisma'
import { getShopConfigCached } from '@/modules/shop/lib/config'
import { formatPrice } from './product-format'
import {
  claimMatchesOrder,
  orderStatusWords,
  trackingStageWords,
  type OrderClaim,
  type OrderIdentity,
} from './order-verify'
import { normaliseCompany, normaliseOrderNumber } from './text'

// ---------------------------------------------------------------------------
// Looking an order up for a caller who has said who they are.
//
// Two steps, and the order of them is the security: candidates are found by
// whatever identifier the caller gave, then EVERY candidate is checked against
// the full claim in order-verify.ts. Only an order that passes is read in
// detail, and the detail deliberately leaves out email, phone, street address
// and tracking numbers - a caller who has proved the postcode is told the town
// and the progress, not handed the customer record.
// ---------------------------------------------------------------------------

const CANDIDATE_LIMIT = 25
const MAX_ORDERS_RETURNED = 3

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
    return prisma.$queryRaw<CandidateRow[]>(Prisma.sql`
      SELECT ${columns} FROM "shp_orders" o
      WHERE ${saleOnly} AND regexp_replace(upper(o."order_number"), '[^A-Z0-9]', '', 'g') = ${wanted}
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
  status: string
  payment: string
  total: string
  deliveringTo: string | null
  items: Array<{ name: string; quantity: number }>
  deliveries: Array<{
    carrier: string | null
    dispatched: string
    progress: string | null
    expectedDelivery: string | null
    deliveredOn: string | null
  }>
}

export type OrderLookupOutcome =
  | { matched: true; orders: VerifiedOrder[]; internalNumbers: string[] }
  | { matched: false }

type OrderRow = {
  id: string
  order_number: string
  status: string
  payment_status: string
  created_at: Date
  total: unknown
  currency: string
  shipping_address: unknown
}

type ItemRow = { order_id: string; product_name: string; quantity: number }

type ShipmentRow = {
  order_id: string
  carrier: string | null
  shipped_at: Date
  tracking_stage: string | null
  delivery_date: string | null
  delivery_slot_start: string | null
  delivery_slot_end: string | null
  delivered_at: Date | null
}

function day(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function expected(row: ShipmentRow): string | null {
  if (!row.delivery_date) return null
  return row.delivery_slot_start && row.delivery_slot_end
    ? `${row.delivery_date}, between ${row.delivery_slot_start} and ${row.delivery_slot_end}`
    : row.delivery_date
}

export async function lookupOrders(claim: OrderClaim): Promise<OrderLookupOutcome> {
  const candidates = await findCandidates(claim)
  const passed = candidates.filter((row) => claimMatchesOrder(claim, identityOf(row)))
  if (passed.length === 0) return { matched: false }

  const ids = passed.slice(0, MAX_ORDERS_RETURNED).map((row) => row.id)
  const [orders, items, shipments, config] = await Promise.all([
    prisma.$queryRaw<OrderRow[]>(Prisma.sql`
      SELECT o."id", o."order_number", o."status", o."payment_status", o."created_at", o."total", o."currency", o."shipping_address"
      FROM "shp_orders" o WHERE o."id" IN (${Prisma.join(ids)}) ORDER BY o."created_at" DESC
    `),
    prisma.$queryRaw<ItemRow[]>(Prisma.sql`
      SELECT "order_id", "product_name", "quantity"
      FROM "shp_order_items" WHERE "order_id" IN (${Prisma.join(ids)})
    `),
    prisma.$queryRaw<ShipmentRow[]>(Prisma.sql`
      SELECT "order_id", "carrier", "shipped_at", "tracking_stage", "delivery_date",
             "delivery_slot_start", "delivery_slot_end", "delivered_at"
      FROM "shp_shipments" WHERE "order_id" IN (${Prisma.join(ids)}) ORDER BY "shipped_at"
    `),
    getShopConfigCached(),
  ])

  const verified: VerifiedOrder[] = orders.map((order) => ({
    orderNumber: order.order_number,
    placed: day(order.created_at),
    status: orderStatusWords(order.status, order.payment_status),
    payment: order.payment_status.toLowerCase().replace(/_/g, ' '),
    total: formatPrice(Number(order.total), order.currency === 'GBP' ? config.currencySymbol : `${order.currency} `),
    deliveringTo: addressField(order.shipping_address, 'city'),
    items: items
      .filter((item) => item.order_id === order.id)
      .map((item) => ({ name: item.product_name, quantity: item.quantity })),
    deliveries: shipments
      .filter((shipment) => shipment.order_id === order.id)
      .map((shipment) => ({
        carrier: shipment.carrier,
        dispatched: day(shipment.shipped_at),
        progress: trackingStageWords(shipment.tracking_stage),
        expectedDelivery: expected(shipment),
        deliveredOn: shipment.delivered_at ? day(shipment.delivered_at) : null,
      })),
  }))
  return { matched: true, orders: verified, internalNumbers: verified.map((order) => order.orderNumber) }
}

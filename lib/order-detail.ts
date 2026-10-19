import { z } from 'zod'

// ---------------------------------------------------------------------------
// Turning the extra rows around an order (line options, refunds, requests,
// notes) into the plain facts the assistant is allowed to say. Pure, so the
// shapes are tested without a database.
// ---------------------------------------------------------------------------

const LineFields = z.object({
  fields: z
    .array(z.object({ label: z.string().optional(), value: z.string().optional() }))
    .optional(),
})

/** What the customer chose on an order line ("Colour: Beech", "Delivery:
 *  Flat-Pack - by Tuesday 27th of October"), as the order page shows them. */
export function lineChoices(lineMeta: unknown): string[] {
  const parsed = LineFields.safeParse(lineMeta)
  if (!parsed.success) return []
  const out: string[] = []
  for (const field of parsed.data.fields ?? []) {
    const label = field.label?.trim() ?? ''
    const value = field.value?.trim() ?? ''
    if (!value) continue
    out.push(label ? `${label}: ${value}` : value)
  }
  return out
}

const REQUEST_TYPES: Record<string, string> = {
  DAMAGE: 'damage report',
  RETURN: 'return request',
  CANCELLATION: 'cancellation request',
  MISSING: 'missing item report',
  FAULT: 'fault report',
}

const REQUEST_STATUSES: Record<string, string> = {
  PENDING: 'waiting for the team to review',
  APPROVED: 'approved',
  REJECTED: 'declined',
  DECLINED: 'declined',
  COMPLETED: 'completed',
  CANCELLED: 'withdrawn',
}

function words(code: string, known: Record<string, string>): string {
  return known[code] ?? code.toLowerCase().replace(/_/g, ' ')
}

export type RequestFacts = { kind: string; status: string; raised: string }

export function describeRequest(row: { type: string; status: string; created_at: Date }): RequestFacts {
  return {
    kind: words(row.type, REQUEST_TYPES),
    status: words(row.status, REQUEST_STATUSES),
    raised: row.created_at.toISOString().slice(0, 10),
  }
}

const REFUND_STATUSES: Record<string, string> = {
  PENDING: 'being processed',
  PROCESSING: 'being processed',
  COMPLETED: 'refunded',
  SUCCEEDED: 'refunded',
  FAILED: 'could not be completed, the team is looking at it',
}

export function refundStatusWords(status: string): string {
  return words(status.toUpperCase(), REFUND_STATUSES)
}

const CHARGE_STATUSES: Record<string, string> = {
  PENDING: 'waiting to be paid',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  VOID: 'cancelled',
}

export function chargeStatusWords(status: string): string {
  return words(status.toUpperCase(), CHARGE_STATUSES)
}

/** Distinct values, ignoring case and blanks, first spelling kept. */
export function distinctEmails(values: readonly string[]): string[] {
  const seen = new Map<string, string>()
  for (const value of values) {
    const email = value.trim()
    if (email && !seen.has(email.toLowerCase())) seen.set(email.toLowerCase(), email)
  }
  return [...seen.values()]
}

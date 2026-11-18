import { z } from 'zod'

// ---------------------------------------------------------------------------
// Saving a phone basket as a quote, through whatever module publishes one.
//
// quote-for-shop publishes a saver at `shop.basket-quote-saver` (see its
// lib/save-basket.ts): it prices the lines, writes a SAVED quote, emails the
// shopper their copy and alerts the owner, under its own settings. This module
// is not allowed to need it - plenty of shops answer the phone without quotes
// installed - so nothing here imports it. The point is read at run time and its
// answer checked against the shape below; anything else is "no saver", and the
// assistant falls back to texting the basket link as it always did.
// ---------------------------------------------------------------------------

export const BASKET_QUOTE_SAVER_POINT = 'shop.basket-quote-saver'

export type QuoteSaveInput = {
  lines: Array<{ productId: string; quantity: number }>
  customerName: string
  customerEmail: string
  customerPhone: string
  staffNotes: string
}

const SavedResult = z.object({
  ok: z.literal(true),
  quote: z.object({
    id: z.string().min(1),
    quoteNumber: z.string(),
    code: z.string(),
    url: z.string().min(1),
  }),
  emailedCustomer: z.boolean(),
  unavailable: z.array(z.object({ name: z.string(), reason: z.string() })).default([]),
})
const RefusedResult = z.object({ ok: z.literal(false), message: z.string() })

export type QuoteSaveResult = z.infer<typeof SavedResult> | z.infer<typeof RefusedResult>

type Saver = {
  canSave: () => Promise<boolean>
  save: (input: QuoteSaveInput) => Promise<unknown>
}

function isSaver(value: unknown): value is Saver {
  const candidate = value as Partial<Saver> | null
  return !!candidate && typeof candidate.canSave === 'function' && typeof candidate.save === 'function'
}

async function findSaver(): Promise<Saver | null> {
  // Dynamic, as twilio's inbound-call-handlers does it: the server map pulls in
  // every serverOnly point's implementation, which a tool call that never saves a
  // quote has no reason to load.
  const { moduleServerExtensionPointComponents } = await import('@/lib/modules/extension-points.server')
  const published: unknown[] = Object.values(moduleServerExtensionPointComponents[BASKET_QUOTE_SAVER_POINT] ?? {})
  return published.find(isSaver) ?? null
}

/** Whether a basket can be saved as a quote here right now: a saver is
 *  installed and its own settings allow it. Never throws. */
export async function quotesAvailable(): Promise<boolean> {
  try {
    const saver = await findSaver()
    return saver ? await saver.canSave() : false
  } catch {
    return false
  }
}

/** Saves the lines as a quote, or null when no saver is installed. A saver
 *  that answers in an unexpected shape is treated as a refusal, never trusted. */
export async function saveQuote(input: QuoteSaveInput): Promise<QuoteSaveResult | null> {
  const saver = await findSaver()
  if (!saver) return null
  const answer = await saver.save(input)
  const saved = SavedResult.safeParse(answer)
  if (saved.success) return saved.data
  const refused = RefusedResult.safeParse(answer)
  return refused.success ? refused.data : { ok: false, message: 'The quote could not be saved.' }
}

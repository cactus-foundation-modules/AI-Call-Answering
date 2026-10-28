import type { ShpConfig } from '@/modules/shop/lib/config'

// ---------------------------------------------------------------------------
// How the shop is paid and what paperwork follows, in words the assistant can
// say.
//
// Pure: facts in, sentences out. The facts are read live (payment-queries.ts)
// from shop's own settings and payment providers on every call, so switching a
// method off, renaming it or changing when invoices go out reaches the phone
// the moment it is saved, with nothing to set up again. Only the wording of the
// rules lives here, where a test can read it.
// ---------------------------------------------------------------------------

/** One way of paying that would reach checkout right now. */
export type PaymentMethodFacts = {
  name: string
  /** The line printed under it at checkout, owner's wording or the provider's. */
  description: string | null
  /** Card brands it takes, where it takes cards and says which. */
  cards: string[] | null
  /** Wallets it offers (Apple Pay, Google Pay), where it says. */
  wallets: string[] | null
  /** True for a method somebody settles by hand later - a bank transfer, cash -
   *  rather than one that takes the money at checkout. */
  paidAfterOrdering: boolean
  /** Whether an order placed this way gets a pro-forma invoice. */
  proforma: boolean
  /** "orders of £500 and over", where the shop limits it. */
  onlyFor: string | null
}

export type InvoiceSettings = Pick<
  ShpConfig,
  | 'invoicesEnabled'
  | 'invoiceIssueOn'
  | 'invoiceShowToCustomer'
  | 'invoiceAttachToEmail'
  | 'proformaEnabled'
  | 'proformaShowToCustomer'
  | 'proformaAttachToEmail'
  | 'proformaTerms'
>

/** The moment a VAT invoice is raised automatically, as a clause that follows
 *  "a VAT invoice is issued". Null where nothing is raised automatically. */
export function invoiceMoment(settings: Pick<InvoiceSettings, 'invoicesEnabled' | 'invoiceIssueOn'>): string | null {
  if (!settings.invoicesEnabled) return null
  switch (settings.invoiceIssueOn) {
    case 'PAID':
      return 'as soon as the order has been paid for'
    case 'DISPATCHED':
      return 'when the order is dispatched'
    case 'COMPLETED':
      return 'once the order is complete, which is when everything on it has been delivered and nothing is left to pay'
    case 'MANUAL':
      return null
  }
}

/** Where a customer finds an invoice once there is one. */
function invoiceWhere(settings: Pick<InvoiceSettings, 'invoiceShowToCustomer' | 'invoiceAttachToEmail' | 'invoiceIssueOn'>): string {
  const places: string[] = []
  if (settings.invoiceAttachToEmail && settings.invoiceIssueOn === 'COMPLETED') places.push('attached to the email saying the order is complete')
  if (settings.invoiceShowToCustomer) places.push('on their order page to view or download')
  return places.length > 0 ? places.join(', and ') : 'from the team, who will send a copy on request (take a callback)'
}

/** The standing rule for VAT invoices. */
export function vatInvoicePolicy(settings: InvoiceSettings): string {
  if (!settings.invoicesEnabled) {
    return 'This shop does not issue VAT invoices through its website. If a caller needs one, do not promise one: take a callback so the team can help.'
  }
  const moment = invoiceMoment(settings)
  if (!moment) {
    return 'VAT invoices are raised by the team by hand, not automatically. Never promise when one will arrive: if a caller needs one, take a callback.'
  }
  return [
    `A VAT invoice is issued automatically ${moment}. The customer gets it ${invoiceWhere(settings)}.`,
    'It is never issued before that point, whatever the payment method, and you cannot issue one early, send one now or bring it forward. If a caller needs a VAT invoice sooner, say when it will come and offer a callback so the team can look at it.',
    'It is made out from the order, including the company name on the order if one was given.',
  ].join(' ')
}

/** The standing rule for pro-formas, given which methods carry one. */
export function proformaPolicy(settings: InvoiceSettings, proformaMethods: readonly string[]): string {
  if (!settings.proformaEnabled || proformaMethods.length === 0) {
    return 'This shop does not issue pro-forma invoices. Never offer or promise one.'
  }
  const methods = joinWords(proformaMethods)
  const where: string[] = []
  if (settings.proformaShowToCustomer) where.push('on the thank-you page and their order page')
  if (settings.proformaAttachToEmail) where.push('attached to the order email that has the payment details')
  const moment = invoiceMoment(settings)
  return [
    `An order paid by ${methods} gets a pro-forma invoice the moment it is placed${where.length > 0 ? `, ${where.join(', and ')}` : ''}.`,
    'It shows what is owed, how to pay, and the company name on the order if one was given, so an accounts department can pay from it.',
    'It is NOT a VAT invoice and you must never call it one.',
    moment ? `The VAT invoice follows separately, ${moment}.` : '',
    `Pro-formas are only for ${methods}. A method that takes the money at checkout (card, instant bank payment) has no pro-forma: the order is paid there and then.`,
    'There is no pro-forma without an order. Somebody who wants one places the order and chooses that payment method; you cannot make one up on the phone.',
    'A cancelled order has no pro-forma.',
    settings.proformaTerms.trim() ? `The pro-forma's own terms say: "${settings.proformaTerms.trim()}"` : '',
  ].filter(Boolean).join(' ')
}

/** What the caller can be told about the paperwork on one order they have
 *  proved is theirs. */
export function orderPaperwork(
  settings: InvoiceSettings,
  order: { invoiced: boolean; proformaAvailable: boolean; cancelledOrRefunded: boolean },
): string {
  const parts: string[] = []
  if (order.invoiced) {
    parts.push(`A VAT invoice has been issued for this order. They have it ${invoiceWhere(settings)}.`)
  } else if (!order.cancelledOrRefunded) {
    const moment = invoiceMoment(settings)
    parts.push(
      moment
        ? `No VAT invoice yet: one is issued ${moment}. It cannot be issued sooner.`
        : 'No VAT invoice has been issued. If they need one, take a callback.',
    )
  }
  if (order.proformaAvailable) {
    const where: string[] = []
    if (settings.proformaShowToCustomer) where.push('on their order page')
    if (settings.proformaAttachToEmail) where.push('attached to their order email')
    parts.push(`There is a pro-forma invoice for it${where.length > 0 ? `, ${where.join(' and ')}` : ''}. That is not a VAT invoice.`)
  }
  return parts.join(' ')
}

/** "card, bank transfer and cash". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/** A method as the assistant should speak of it. */
export function describeMethod(method: PaymentMethodFacts): string {
  const takes: string[] = []
  if (method.cards && method.cards.length > 0) takes.push(joinWords(method.cards))
  if (method.wallets && method.wallets.length > 0) takes.push(joinWords(method.wallets))
  const limit = method.onlyFor ? ` (only for ${method.onlyFor})` : ''
  return takes.length > 0 ? `${method.name}: ${takes.join(', plus ')}${limit}` : `${method.name}${limit}`
}

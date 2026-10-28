import { describe, expect, it } from 'vitest'
import { describeMethod, invoiceMoment, joinWords, orderPaperwork, proformaPolicy, vatInvoicePolicy, type InvoiceSettings } from './payment-words'

const SETTINGS: InvoiceSettings = {
  invoicesEnabled: true,
  invoiceIssueOn: 'COMPLETED',
  invoiceShowToCustomer: true,
  invoiceAttachToEmail: true,
  proformaEnabled: true,
  proformaShowToCustomer: true,
  proformaAttachToEmail: true,
  proformaTerms: 'Nothing is dispatched until payment has cleared.',
}

describe('invoiceMoment', () => {
  it('names completion as delivery with nothing owing', () => {
    expect(invoiceMoment(SETTINGS)).toMatch(/delivered and nothing is left to pay/)
  })
  it('is nothing when invoices are raised by hand or not at all', () => {
    expect(invoiceMoment({ ...SETTINGS, invoiceIssueOn: 'MANUAL' })).toBeNull()
    expect(invoiceMoment({ ...SETTINGS, invoicesEnabled: false })).toBeNull()
  })
})

describe('vatInvoicePolicy', () => {
  it('says when, where, and that it cannot come early', () => {
    const words = vatInvoicePolicy(SETTINGS)
    expect(words).toMatch(/once the order is complete/)
    expect(words).toMatch(/attached to the email saying the order is complete/)
    expect(words).toMatch(/cannot issue one early/)
  })
  it('promises nothing on a shop that does not invoice', () => {
    expect(vatInvoicePolicy({ ...SETTINGS, invoicesEnabled: false })).toMatch(/do not promise one/)
  })
  it('does not claim the completion email carries an invoice raised on payment', () => {
    expect(vatInvoicePolicy({ ...SETTINGS, invoiceIssueOn: 'PAID' })).not.toMatch(/order is complete\./)
  })
})

describe('proformaPolicy', () => {
  it('names only the methods that carry one, and says it is not a VAT invoice', () => {
    const words = proformaPolicy(SETTINGS, ['bank transfer'])
    expect(words).toMatch(/paid by bank transfer gets a pro-forma/)
    expect(words).toMatch(/NOT a VAT invoice/)
    expect(words).toMatch(/company name/)
    expect(words).toMatch(/Nothing is dispatched until payment has cleared/)
  })
  it('offers none when switched off or no method carries one', () => {
    expect(proformaPolicy({ ...SETTINGS, proformaEnabled: false }, ['bank transfer'])).toMatch(/does not issue pro-forma/)
    expect(proformaPolicy(SETTINGS, [])).toMatch(/does not issue pro-forma/)
  })
})

describe('orderPaperwork', () => {
  it('reports an issued invoice and a pro-forma', () => {
    const words = orderPaperwork(SETTINGS, { invoiced: true, proformaAvailable: true, cancelledOrRefunded: false })
    expect(words).toMatch(/VAT invoice has been issued/)
    expect(words).toMatch(/pro-forma invoice for it/)
  })
  it('says when the invoice will come for an open order', () => {
    expect(orderPaperwork(SETTINGS, { invoiced: false, proformaAvailable: false, cancelledOrRefunded: false }))
      .toMatch(/No VAT invoice yet: one is issued once the order is complete/)
  })
  it('promises no invoice on a cancelled order', () => {
    expect(orderPaperwork(SETTINGS, { invoiced: false, proformaAvailable: false, cancelledOrRefunded: true })).toBe('')
  })
})

describe('describeMethod', () => {
  it('lists cards, wallets and a limit', () => {
    expect(describeMethod({
      name: 'Card payment', description: null, cards: ['Visa', 'Mastercard'], wallets: ['Apple Pay'],
      paidAfterOrdering: false, proforma: false, onlyFor: 'orders up to £5000',
    })).toBe('Card payment: Visa and Mastercard, plus Apple Pay (only for orders up to £5000)')
  })
  it('is just the name for a method with nothing to add', () => {
    expect(describeMethod({ name: 'Bank transfer', description: null, cards: null, wallets: null, paidAfterOrdering: true, proforma: true, onlyFor: null }))
      .toBe('Bank transfer')
  })
})

describe('joinWords', () => {
  it('joins with commas and a final and', () => {
    expect(joinWords(['a', 'b', 'c'])).toBe('a, b and c')
    expect(joinWords(['a'])).toBe('a')
    expect(joinWords([])).toBe('')
  })
})

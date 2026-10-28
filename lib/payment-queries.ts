import { getAvailablePaymentMethods, getShopConfigCached } from '@/modules/shop/lib/config'
import { getPaymentProvider, resolvePaymentMethodDescriptions, resolveProviderLabel } from '@/modules/shop/lib/payments/registry'
import { orderValueLimitFor, orderValueLimitSentence } from '@/modules/shop/lib/payments/order-value-limits'
import type { ShpPaymentProvider } from '@/modules/shop/lib/payments/provider'
import { formatPrice } from './product-format'
import { describeMethod, proformaPolicy, vatInvoicePolicy, type PaymentMethodFacts } from './payment-words'

// ---------------------------------------------------------------------------
// How the shop can be paid, read live on every call.
//
// Straight from shop: the methods that would reach checkout right now (its own
// on/off switches, credentials and each module's readiness all applied), in the
// owner's order, with the owner's names and checkout wording. Card brands and
// wallets come from the provider that takes them, so nothing here names a
// payment module or keeps its own copy of the list. Nothing is written.
// ---------------------------------------------------------------------------

async function brandsOf(provider: ShpPaymentProvider): Promise<{ cards: string[] | null; wallets: string[] | null }> {
  if (!provider.getAcceptedBrands) return { cards: null, wallets: null }
  try {
    const brands = await provider.getAcceptedBrands()
    return { cards: brands.cards.length > 0 ? brands.cards : null, wallets: brands.wallets.length > 0 ? brands.wallets : null }
  } catch (error) {
    // A provider that cannot say must not take the rest of the answer with it.
    console.error(`[ai-call-answering] payment provider "${provider.id}" could not list its brands:`, error)
    return { cards: null, wallets: null }
  }
}

export async function paymentMethodFacts(): Promise<PaymentMethodFacts[]> {
  const [config, methods] = await Promise.all([getShopConfigCached(), getAvailablePaymentMethods()])
  const descriptions = resolvePaymentMethodDescriptions(config.paymentMethodDescriptions)
  const facts = await Promise.all(
    methods.map(async (id): Promise<PaymentMethodFacts | null> => {
      const provider = getPaymentProvider(id)
      if (!provider) return null
      const [name, brands] = await Promise.all([resolveProviderLabel(provider), brandsOf(provider)])
      const manual = provider.confirmMode === 'manual'
      return {
        name,
        description: descriptions[id] ?? null,
        ...brands,
        paidAfterOrdering: manual,
        proforma: manual && config.proformaEnabled,
        onlyFor: orderValueLimitSentence(
          orderValueLimitFor(config.paymentMethodOrderValueLimits, id),
          (amount) => formatPrice(amount, config.currencySymbol),
        ),
      }
    }),
  )
  return facts.filter((fact): fact is PaymentMethodFacts => fact !== null)
}

/** The whole answer to "how can I pay, and when do I get an invoice". */
export async function paymentInfo(): Promise<Record<string, unknown>> {
  const [config, methods] = await Promise.all([getShopConfigCached(), paymentMethodFacts()])
  if (methods.length === 0) {
    return { ok: true, methods: [], message: 'No payment method is switched on at the moment. Do not guess: offer a callback.' }
  }
  return {
    ok: true,
    methods: methods.map((method) => ({ ...method, summary: describeMethod(method) })),
    vatInvoices: vatInvoicePolicy(config),
    proformaInvoices: proformaPolicy(config, methods.filter((method) => method.proforma).map((method) => method.name.toLowerCase())),
    note: 'These are the only ways to pay. Never offer one that is not listed, and never name a card brand or wallet the list does not give. Payment is made on the website, never over the phone: never take card or bank details. Do not read out bank account numbers; they are on the pro-forma and the order email.',
  }
}

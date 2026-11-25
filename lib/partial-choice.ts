// Copied from the chat assistant (modules/ai-agent-for-live-chat/lib/shop/) and kept in step
// by hand: the two modules never import each other. Learned on live chats; a
// caller asks the same questions.
// ---------------------------------------------------------------------------
// The options a visitor actually chose, when their words leave more than one
// variation. Pure, pinned by lib/shop/partial-choice.test.ts.
//
// Learned on a live chat: asked for "your cheapest yellow office chair", the
// assistant linked the cheapest yellow variation, so the card, the email and
// the text all arrived with seat adjustment, arms and back colour chosen too -
// "I only wanted the yellow colour selected". And a desk asked for as "120cm,
// no mod panel, black frame" came with cable ports and a depth picked.
//
// So where several variations fit, only the options every one of them shares
// are chosen: those are the ones the visitor's words settled. The link carries
// just those (`?upholstery-colour=senna-yellow`), which the storefront, Live
// Chat's card and the Unified Inbox all open with the rest left to choose, and
// the inbox is handed the same choice as `picks` (its ProductRef format,
// `option-key.value-slug` joined with "+", sorted).
// ---------------------------------------------------------------------------

/** One option of one variation: [option name, value slug, value label]. */
export type OptionPick = readonly [name: string, slug: string, label: string]

/** An option's query key, as the storefront and the variations module spell
 *  it. Restated here (and in product-links.ts) so this file stays pure. */
function paramKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The options every fitting variation shares, in the shop's order. An option
 * the listing sells in only one value is left out: nobody chose it, and the
 * page has nothing else to pick. `all` is every switched-on variation of the
 * listing; `fits` the ones the visitor's words fit.
 */
export function settledOptions(all: ReadonlyArray<readonly OptionPick[]>, fits: ReadonlyArray<readonly OptionPick[]>): OptionPick[] {
  const first = fits[0]
  if (!first) return []
  const valuesOf = new Map<string, Set<string>>()
  for (const picks of all) {
    for (const [name, slug] of picks) {
      const values = valuesOf.get(name) ?? new Set<string>()
      values.add(slug)
      valuesOf.set(name, values)
    }
  }
  return first.filter(([name, slug]) =>
    (valuesOf.get(name)?.size ?? 0) > 1
    && fits.every((picks) => picks.some(([otherName, otherSlug]) => otherName === name && otherSlug === slug)))
}

const SAFE = /^[a-z0-9-]+$/

/** The Unified Inbox's spelling of a partial choice, or null for none. */
export function picksRef(settled: readonly OptionPick[]): string | null {
  const parts = settled
    .map(([name, slug]) => [paramKey(name), slug] as const)
    .filter(([key, slug]) => SAFE.test(key) && SAFE.test(slug))
    .map(([key, slug]) => `${key}.${slug}`)
    .sort()
  return parts.length > 0 ? parts.join('+') : null
}

/** A stored picks string, or null for anything that is not one. */
export function parsePicksRef(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^[a-z0-9-]+\.[a-z0-9-]+(?:\+[a-z0-9-]+\.[a-z0-9-]+)*$/.test(value) ? value : null
}

/** The options already chosen for a listing earlier in a chat, by query key
 *  and value slug, read from the address the chat recorded for it (a chosen
 *  variation's, or a partial choice's). The delivery service is not an option.
 *  Pure. */
export function choicesInAddress(address: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (!address) return out
  try {
    new URL(address).searchParams.forEach((value, key) => {
      if (key !== 'delivery-service' && value && !out.has(key)) out.set(key, value)
    })
  } catch {
    // An address that does not parse carries no choices.
  }
  return out
}

/**
 * Earlier choices carried into a new look-up. For each option chosen before,
 * the fits are narrowed to that value, but only where the new words left that
 * option open (the fits still differ on it) and some fit has it: a value the
 * visitor has just changed ("actually white") is never overruled, because the
 * fits then all agree on the new one. Returns the indexes kept, in order, and
 * the labels carried. Pure.
 *
 * Learned on a live chat: a visitor who had asked about the planter top and
 * then asked for the cupboard "in blue" was shown it blue without the planter,
 * "you did not pick the planter option for me? fail".
 */
export function carryChoices(
  fits: ReadonlyArray<readonly OptionPick[]>,
  carried: ReadonlyMap<string, string>,
): { kept: number[]; carried: string[] } {
  let kept = fits.map((_, index) => index)
  const labels: string[] = []
  for (const [key, slug] of carried) {
    const valueAt = (index: number) => fits[index]?.find(([name]) => paramKey(name) === key)
    const values = new Set(kept.map((index) => valueAt(index)?.[1]).filter((value): value is string => !!value))
    if (values.size < 2 || !values.has(slug)) continue
    kept = kept.filter((index) => valueAt(index)?.[1] === slug)
    const label = kept.length > 0 ? valueAt(kept[0] as number)?.[2] : undefined
    if (label) labels.push(label)
  }
  return { kept, carried: labels }
}

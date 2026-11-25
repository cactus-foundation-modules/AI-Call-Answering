// Lines in the owner's extra instructions that work against the built-in ones.
//
// The extra instructions are appended after the module's own rules, and a model
// given two rules that disagree follows whichever it noticed last - usually the
// owner's. Most of the damage is facts typed in once that the tools already read
// live: a "no invoicing" line written before bank transfer was switched on
// stopped the assistant reading out the bank details. This spots the common
// kinds so the settings screen can say so while the text is being written.
//
// Pure and dependency-free: the settings screen runs it as the owner types.

/**
 * Longest the extra instructions may be, counted the way the browser and the
 * save check both count (`String.length`), so the counter under the box and
 * the refusal can never disagree. Plain file with no directive: the settings
 * tab and the save route both read it.
 */
export const EXTRA_INSTRUCTIONS_MAX_LENGTH = 10000

export type InstructionConflict = {
  /** The sentence that triggered it, as written. */
  quote: string
  /** Why it is a problem and what to do instead, in plain words. */
  advice: string
}

type Rule = {
  test: RegExp
  /** The sentence must also match this, to be about the right subject. */
  about?: RegExp
  /** ...and must not match this. */
  notAbout?: RegExp
  /** Skip a sentence that says not to do the thing, e.g. "never say next-day". */
  skipWhenNegated?: boolean
  /** A sentence matching this is left alone even though `test` matched. */
  skipWhen?: RegExp
  advice: string
}

const NEGATION = /\b(never|not|don'?t|do not|no)\b/i

const RULES: Rule[] = [
  {
    test: /\b(invoic\w*|bank transfer|bank details|pro-?formas?|card payments?|pay(ing)? by|credit terms?|on credit|no credit|payment methods?)\b/i,
    advice:
      "Payment methods, bank details, VAT invoices and pro-formas are read live from the shop's Payments and Invoices tabs on every call. A line about them here goes stale when those tabs change, and can stop the assistant giving the bank details. Leave payments out of these instructions.",
  },
  {
    test: /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(co\.uk|org\.uk|com|uk|net|org|io|shop)\/\S*/i,
    // A link the owner wants sent ("offer to send them the link to the article:
    // https://...") is how a page off the site becomes sendable at all, so that
    // sentence is not a clash. A bare address to recite still is.
    skipWhen: /\b(send|email|e-mail|text|share|offer)\b[^.]{0,80}\b(link|article|page|address)\b/i,
    advice:
      'This asks the assistant to give out a web address with a page path, which nobody can take down from a phone call. The built-in rules look the order up and offer to email the link instead.',
  },
  {
    test: /\b(next[- ]day|same[- ]day|within \d+\s*(working\s*)?days|\d+\s*(-|to)\s*\d+\s*(working\s*)?days|\d+\s*working days)\b/i,
    about: /\b(deliver\w*|arriv\w*|ship\w*|lead times?)\b/i,
    notAbout: /\b(return\w*|cancel\w*|report\w*)\b/i,
    skipWhenNegated: true,
    advice:
      'A fixed delivery time here overrides the dates the assistant reads for each product and option from the shop. Leave delivery times to those.',
  },
  {
    // A price stated as a fact, not one given as an example of how to say one.
    test: /\b(costs?|is|are|from|priced at|only|just)\s+£\s?\d/i,
    skipWhenNegated: true,
    advice: 'A price written here goes stale when the shop changes. The assistant reads every price live, option by option.',
  },
  {
    test: /\b(you are|you're|say you are|say you're|pretend( to be)?|act as)\b[^.\n]{0,30}\b(real |human |actual )?(person|human|member of (the )?staff|employee)\b/i,
    skipWhenNegated: true,
    advice:
      'Callers must never be told, or led to believe, that they are talking to a person. The built-in rules have the assistant say plainly that it is the digital assistant when asked. A name and persona are fine.',
  },
  {
    // The owner's chosen wording: "digital assistant", never "automated".
    // Kept in step with the chat assistant's copy of this rule.
    test: /\b(automated|automatic|ai|robot|bot|chat ?bot|virtual)\s+(assistant|agent|helper|bot)\b|\b(you are|you're|say you are|call yourself)\s+an?\s+(bot|chat ?bot|robot|ai)\b/i,
    advice:
      'The assistant always calls itself a digital assistant. A line telling it to call itself an automated or virtual assistant, a bot or an AI fights that. Leave how it describes itself to the built-in rules.',
  },
  {
    // "Returns are raised on the order page, not by phone": written before the
    // assistant could raise them, and it sends every caller off to do it alone.
    test: /\b(order page|account page|on the website|online|themselves|not by phone|not over the phone)\b/i,
    about: /\b(return\w*|cancel\w*|damage\w*|report\w*|faulty|missing|shortages?)\b/i,
    // "Never send them to their order page to do it" says the opposite.
    notAbout: /\b(never|don'?t|do not)\s+(send|ask|tell|direct|point)\b/i,
    advice:
      'The assistant raises cancellations, returns and issue reports for the caller once their order is checked, and asks for photographs of any damage in the confirmation email. A line sending callers to do it themselves stops it. Say instead what your rules are (the returns window, how long they have to report damage) and leave the raising to the assistant.',
  },
]

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((piece) => piece.replace(/^[-*•\s]+/, '').trim())
    .filter(Boolean)
}

export function findInstructionConflicts(text: string): InstructionConflict[] {
  const found: InstructionConflict[] = []
  const seenAdvice = new Set<string>()
  for (const sentence of sentences(text)) {
    for (const rule of RULES) {
      if (!rule.test.test(sentence)) continue
      if (rule.about && !rule.about.test(sentence)) continue
      if (rule.notAbout && rule.notAbout.test(sentence)) continue
      if (rule.skipWhenNegated && NEGATION.test(sentence)) continue
      if (rule.skipWhen?.test(sentence)) continue
      // One warning per kind: the first sentence is enough to find the rest.
      if (seenAdvice.has(rule.advice)) continue
      seenAdvice.add(rule.advice)
      found.push({ quote: sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence, advice: rule.advice })
    }
  }
  return found
}

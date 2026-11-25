import { editDistance } from './text'

// ---------------------------------------------------------------------------
// Every way a caller's word might be written in the catalogue.
//
// A caller says "light", the product page says "Lite". A caller says "color",
// the shop says "colour". A search that matches the letters as heard finds
// nothing and the assistant concludes the shop does not sell it. So each word
// searched for is widened to its other spellings first, and the shop's own
// vocabulary is used to forgive a slip that no rule foresaw.
//
// Pure: no imports from the database, so everything here is unit-tested alone.
// ---------------------------------------------------------------------------

/** Words the trade spells more than one way. Every member of a group stands for
 *  all the others, in either direction. */
const SPELLING_GROUPS: ReadonlyArray<readonly string[]> = [
  ['light', 'lite'],
  ['night', 'nite'],
  ['colour', 'color'],
  ['grey', 'gray'],
  ['centre', 'center'],
  ['metre', 'meter'],
  ['aluminium', 'aluminum'],
  ['tyre', 'tire'],
  ['plough', 'plow'],
  ['storey', 'story'],
  ['cheque', 'check'],
  ['catalogue', 'catalog'],
  ['mould', 'mold'],
  ['fibre', 'fiber'],
  ['cosy', 'cozy'],
  ['wheel', 'wheels', 'castor', 'caster', 'castors', 'casters'],
  ['tv', 'television'],
  ['sofa', 'settee', 'couch'],
  ['cabinet', 'cupboard'],
  ['bin', 'wastebin', 'wastepaper'],
  ['cm', 'centimetre', 'centimeter', 'centimetres', 'centimeters'],
  ['mm', 'millimetre', 'millimeter', 'millimetres', 'millimeters'],
  ['foot', 'feet', 'ft'],
]

const GROUP_OF = new Map<string, readonly string[]>()
for (const group of SPELLING_GROUPS) {
  for (const word of group) GROUP_OF.set(word, group)
}

/** Suffix and letter-pattern swaps that turn one spelling into another. Applied
 *  one at a time, never stacked, so the list of variants stays short. */
const PATTERN_SWAPS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ight$/, 'ite'],
  [/ite$/, 'ight'],
  [/our$/, 'or'],
  [/or$/, 'our'],
  [/ise$/, 'ize'],
  [/ize$/, 'ise'],
  [/ised$/, 'ized'],
  [/ized$/, 'ised'],
  [/ising$/, 'izing'],
  [/izing$/, 'ising'],
  [/tre$/, 'ter'],
  [/ter$/, 'tre'],
  [/ough$/, 'ow'],
  [/ae/, 'e'],
  [/oe/, 'e'],
  [/ph/, 'f'],
  [/(.)\1/, '$1'],
]

const MAX_VARIANTS = 8

/** Singular and plural of a word, both ways. Blunt on purpose: a variant that
 *  is not a word simply matches nothing. */
function pluralForms(word: string): string[] {
  if (word.length < 4) return []
  if (word.endsWith('ies')) return [`${word.slice(0, -3)}y`]
  if (word.endsWith('es') && /(ch|sh|x|s|z)es$/.test(word)) return [word.slice(0, -2)]
  if (word.endsWith('s') && !word.endsWith('ss')) return [word.slice(0, -1)]
  if (word.endsWith('y')) return [`${word.slice(0, -1)}ies`]
  if (/(ch|sh|x|s|z)$/.test(word)) return [`${word}es`]
  return [`${word}s`]
}

/** The word as typed, then every other plausible spelling of it, capped. */
export function spellingVariants(word: string): string[] {
  const base = word.toLowerCase()
  const out = new Set<string>([base])
  for (const member of GROUP_OF.get(base) ?? []) out.add(member)
  for (const form of pluralForms(base)) {
    out.add(form)
    for (const member of GROUP_OF.get(form) ?? []) out.add(member)
  }
  for (const [pattern, replacement] of PATTERN_SWAPS) {
    if (pattern.test(base)) out.add(base.replace(pattern, replacement))
  }
  return [...out].filter((variant) => variant.length >= 2).slice(0, MAX_VARIANTS)
}

/** Words the shop's own pages use, lower case, for forgiving a slip. */
export type Vocabulary = ReadonlySet<string>

/** How many letters out a word may be and still count as the same word. Short
 *  words get none: "oak" one letter out is "oat", another word entirely. */
function allowedSlips(word: string): number {
  if (word.length >= 9) return 2
  if (word.length >= 5) return 1
  return 0
}

const MAX_FUZZY_PER_WORD = 3

/** Words in the vocabulary a heard word is probably a slip for, nearest first.
 *  Empty when the word is already in the vocabulary: no slip to forgive. */
export function nearbyWords(word: string, vocabulary: Vocabulary): string[] {
  const base = word.toLowerCase()
  const slips = allowedSlips(base)
  if (slips === 0 || vocabulary.has(base)) return []
  const found: Array<{ word: string; distance: number }> = []
  for (const candidate of vocabulary) {
    if (Math.abs(candidate.length - base.length) > slips) continue
    // The first letter is rarely the one misheard, and requiring it keeps the scan cheap.
    if (candidate.charAt(0) !== base.charAt(0)) continue
    const distance = editDistance(base, candidate)
    if (distance > 0 && distance <= slips) found.push({ word: candidate, distance })
  }
  found.sort((a, b) => a.distance - b.distance || a.word.localeCompare(b.word))
  return found.slice(0, MAX_FUZZY_PER_WORD).map((entry) => entry.word)
}

/** Each searched-for word widened to the spellings worth trying. A word matches
 *  a product when ANY of its variants does; every word must still match.
 *
 *  Also puts back spacing the caller and the shop disagree about: "head rest"
 *  against "headrest" (adjacent words that join into a word the shop uses), and
 *  "bookcase" against "book case" (one word that splits into two the shop uses). */
export function expandSearchWords(tokens: string[], vocabulary: Vocabulary | null): string[][] {
  const expanded = tokens.map((token) => spellingVariants(token))
  if (vocabulary && vocabulary.size > 0) {
    tokens.forEach((token, index) => {
      const variants = expanded[index] ?? []
      for (const near of nearbyWords(token, vocabulary)) variants.push(near)
      const next = tokens[index + 1]
      if (next && vocabulary.has(`${token}${next}`)) {
        variants.push(`${token}${next}`)
        expanded[index + 1]?.push(`${token}${next}`)
      }
      // "wooden" for "wood", "golden" for "gold": only when the shop itself
      // uses the shorter word, so "garden" never turns into "gard".
      if (token.length >= 6 && token.endsWith('en') && vocabulary.has(token.slice(0, -2))) variants.push(token.slice(0, -2))
      if (!vocabulary.has(token) && token.length >= 6) {
        for (let cut = 3; cut <= token.length - 3; cut++) {
          const head = token.slice(0, cut)
          const tail = token.slice(cut)
          if (vocabulary.has(head) && vocabulary.has(tail)) {
            variants.push(`${head} ${tail}`)
            break
          }
        }
      }
    })
  }
  return expanded.map((variants) => [...new Set(variants)])
}

/** Whether a stored text contains the word under any of its spellings. Used where
 *  the match is made in memory rather than in SQL. */
export function textHasWord(haystack: string, variants: readonly string[]): boolean {
  const lower = haystack.toLowerCase()
  return variants.some((variant) => lower.includes(variant))
}

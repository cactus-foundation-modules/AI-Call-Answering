// Copied from the chat assistant (modules/ai-agent-for-live-chat/lib/shop/) and kept in step
// by hand: the two modules never import each other. Learned on live chats; a
// caller asks the same questions.
import { spellingVariants } from './spelling'
import { VARIATION_FILLER } from './variation-stock'

// ---------------------------------------------------------------------------
// Which of a listing's variations the visitor's words pick out. Pure, so every
// rule is pinned by tests (lib/shop/variation-match.test.ts).
//
// Learned on a live chat: a visitor asked for an Oslo Air desk at "120cm, no
// mod panel, black frame" with "the black and wooden edge finish". The old rule
// demanded that EVERY word appear somewhere in a variation, so "no", "natural",
// "wood", "edge" and "top" each ruled out all of them, and the assistant told
// the visitor four times that the combination did not exist. It did: "Without
// Modesty Panel", Finish "Black", Frame Colour "Black". So:
//
//   - "no", "not", "without" and "w/o" all mean "without", in the words and in
//     the labels alike, so "no modesty panel" is "Without Modesty Panel" and "no
//     arms" is a label "No Arms". "with"/"without" bind to the word after them
//     and pick a value that starts that way; a "with" that names no "With ..."
//     value (as in "black top with natural wood edge") is just a word.
//   - A word no variation has anywhere ("natural", "wood", "edge") cannot tell
//     variations apart, so it is set aside and reported, never a reason for
//     "no match".
//   - A colour next to an option's own name ("black frame", "frame black")
//     belongs to that option, and a word said twice needs two options that
//     carry it: "black top, black frame" is a black finish AND a black frame,
//     where a single "black" is satisfied by either.
//   - Words that are only an option's name ("frame", "upholstery") narrow
//     nothing on their own.
//   - When nothing fits even then, the nearest variations come back marked as
//     closest, with the words they miss, so the assistant can say what is
//     different instead of that nothing exists.
//   - A value can carry other names too (`aliases`): the colour families the
//     shop's own filter files it under, so "blue" finds "Dark Teal" exactly as
//     the shop's Blue filter does. Learned on a live chat, where a visitor
//     wanting a blue desk was told there were none.
// ---------------------------------------------------------------------------

export type VariationCandidate = {
  optionNames: readonly string[]
  optionValues: readonly string[]
  /** Other names for each value, in step with optionValues: the shop filter's
   *  families it belongs to ("Blue" for "Dark Teal"). Optional. */
  aliases?: ReadonlyArray<readonly string[]>
  /** The variation's own name: matched only when it has no options at all. */
  name: string
}

export type VariationPick = {
  /** Indexes into the rows given, in their order. */
  fits: number[]
  /** Words no variation of this listing carries, set aside. */
  ignored: string[]
  /** True when no variation had every word and `fits` are the nearest. */
  closest: boolean
  /** For closest fits: the words they do not have. */
  unmet: string[]
}

const NEGATIONS = new Set(['no', 'not', 'without', 'wo', 'excluding', 'minus', 'non'])

/** Words that never narrow anything: grammar, and talk about choosing. */
const GLUE = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'of', 'to', 'in', 'on', 'at', 'i', 'me', 'my', 'we', 'you', 'it',
  'is', 'are', 'one', 'some', 'any', 'want', 'need', 'like', 'please', 'just', 'also', 'plus', 'that', 'this',
  'edition', 'type', 'kind',
])

/** Lower case words, sizes split into their numbers ("120x80cm" is 120 and
 *  80), "w/o" read as "without" and every negation folded into "without". */
export function matchWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\bw\/o\b/g, ' without ')
    .replace(/(\d)\s*(?:x|×|\*|by)\s*(?=\d)/g, '$1 ')
    .replace(/(\d)(?:cms?|mm|m)\b/g, '$1')
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .map((word) => (NEGATIONS.has(word) ? 'without' : word))
}

/** Whether a label word is the word wanted, under any of its spellings. A word
 *  of four letters or more also matches the start of a longer one ("modest"
 *  in "modesty"); "with" never matches "without". */
function wordFits(labelWord: string, variants: readonly string[]): boolean {
  return variants.some((variant) => labelWord === variant || (variant.length >= 4 && variant !== 'with' && labelWord.startsWith(variant)))
}

type Slot = { option: string | null; words: string[] }

/** A variation as the matcher sees it: one slot per option value (or its name
 *  when it has no options). */
function slotsOf(row: VariationCandidate): Slot[] {
  if (row.optionValues.length === 0) return [{ option: null, words: matchWords(row.name) }]
  return row.optionValues.map((value, index) => ({
    option: row.optionNames[index] ?? null,
    // The value's own words first: "with"/"without" leads are read from there.
    words: [...matchWords(value), ...(row.aliases?.[index] ?? []).flatMap((alias) => matchWords(alias))],
  }))
}

type Need =
  | { kind: 'word'; word: string; variants: string[]; option: string | null }
  | { kind: 'phrase'; lead: 'with' | 'without'; word: string; variants: string[] }

function needWord(need: Need): string {
  return need.kind === 'word' ? need.word : `${need.lead} ${need.word}`
}

/** Whether one variation meets every need. Same-word needs each want a slot of
 *  their own: a bound one its option's, the rest any other slot carrying it. */
function meets(slots: readonly Slot[], needs: readonly Need[]): boolean {
  return unmetNeeds(slots, needs).length === 0
}

function unmetNeeds(slots: readonly Slot[], needs: readonly Need[]): Need[] {
  const missing: Need[] = []
  const used = new Set<number>()
  // Bound words first, so a free "black" does not take the frame's slot.
  const ordered = [...needs].sort((a, b) => rank(a) - rank(b))
  for (const need of ordered) {
    const at = slots.findIndex((slot, index) => {
      if (need.kind === 'phrase') return slot.words[0] === need.lead && slot.words.slice(1).some((word) => wordFits(word, need.variants))
      if (need.option !== null && slot.option !== need.option) return false
      if (!slot.words.some((word) => wordFits(word, need.variants))) return false
      // A word said more than once needs a different slot each time.
      return !used.has(index) || !needs.some((other) => other !== need && other.kind === 'word' && other.word === need.word)
    })
    if (at < 0) missing.push(need)
    else used.add(at)
  }
  return missing
}

function rank(need: Need): number {
  if (need.kind === 'phrase') return 0
  return need.option !== null ? 1 : 2
}

/** The variations `wanted` picks out of `rows`. A value named in full beats
 *  one that only shares a family with it: "pastel blue" is Pastel Blue, not
 *  Pastel Turquoise, though the shop's Blue filter holds both; a bare "blue"
 *  still means every blue the filter does. */
export function pickVariations(wanted: string, rows: readonly VariationCandidate[]): VariationPick {
  const picked = pickWith(wanted, rows)
  if (picked.closest || picked.fits.length < 2) return picked
  const said = new Set(matchWords(wanted))
  // Per option: the fits whose value shares the most words with what was
  // written, when that is two or more ("pastel blue" in "Pastel Blue & Satin
  // White") and more than some other fit's.
  let fits = picked.fits
  const names = new Set(rows.flatMap((row) => row.optionNames))
  for (const option of names) {
    const shared = (index: number) => {
      const row = rows[index]
      const at = row?.optionNames.indexOf(option) ?? -1
      return at >= 0 ? new Set(matchWords(row?.optionValues[at] ?? '').filter((word) => said.has(word))).size : 0
    }
    const most = Math.max(...fits.map(shared))
    if (most < 2) continue
    const named = fits.filter((index) => shared(index) === most)
    if (named.length < fits.length) fits = named
  }
  return fits === picked.fits ? picked : { ...picked, fits }
}

function pickWith(wanted: string, rows: readonly VariationCandidate[]): VariationPick {
  const all = rows.map((_, index) => index)
  const slotRows = rows.map(slotsOf)
  const words = matchWords(wanted)
  if (words.length === 0 || rows.length === 0) return { fits: all, ignored: [], closest: false, unmet: [] }

  // Every word any variation carries in a value, and each option name's words
  // (only those no other option shares can bind a colour to it).
  const valueWords = new Set(slotRows.flatMap((slots) => slots.flatMap((slot) => slot.words)))
  const nameOwners = new Map<string, Set<string>>()
  for (const row of rows) {
    for (const name of row.optionNames) {
      for (const word of matchWords(name)) {
        const owners = nameOwners.get(word) ?? new Set<string>()
        owners.add(name)
        nameOwners.set(word, owners)
      }
    }
  }
  const ownerOf = (word: string | undefined): string | null => {
    if (!word) return null
    const owners = nameOwners.get(word)
    return owners && owners.size === 1 ? [...owners][0] ?? null : null
  }
  const known = (variants: readonly string[]) => [...valueWords].some((word) => wordFits(word, variants))
  const leads = new Set(slotRows.flatMap((slots) => slots.map((slot) => slot.words[0]).filter((word) => word === 'with' || word === 'without')))

  const needs: Need[] = []
  const ignored: string[] = []
  const consumed = new Set<number>()
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? ''
    if (GLUE.has(word) || consumed.has(index)) continue
    if (word === 'with' || word === 'without') {
      // Bind to one of the next few words that makes a value starting this
      // way: "no mod panel" reaches past "mod" to "panel".
      if (!leads.has(word)) continue
      for (let next = index + 1, looked = 0; next < words.length && looked < 3; next++) {
        const target = words[next] ?? ''
        if (GLUE.has(target)) continue
        looked++
        const phrase: Need = { kind: 'phrase', lead: word, word: target, variants: spellingVariants(target) }
        if (slotRows.some((slots) => unmetNeeds(slots, [phrase]).length === 0)) {
          needs.push(phrase)
          consumed.add(next)
          break
        }
      }
      continue
    }
    const variants = spellingVariants(word)
    if (!known(variants)) {
      // Talk about an option ("frame", "finish", "upholstery") narrows nothing.
      if (!nameOwners.has(word) && !VARIATION_FILLER.has(word)) ignored.push(word)
      continue
    }
    // "black frame" binds forwards; "frame black" backwards, but only when
    // nothing that means something follows ("black frame black top": the
    // second black is the top's, not the frame's).
    const next = words[index + 1]
    const nextMeans = next !== undefined && !GLUE.has(next) && !VARIATION_FILLER.has(next)
    const option = ownerOf(next) ?? (nextMeans ? null : ownerOf(words[index - 1]))
    const boundHere = option !== null && slotRows.some((slots) => slots.some((slot) => slot.option === option && slot.words.some((w) => wordFits(w, variants))))
    needs.push({ kind: 'word', word, variants, option: boundHere ? option : null })
  }

  if (needs.length === 0) return { fits: all, ignored, closest: false, unmet: [] }
  const fits = all.filter((index) => meets(slotRows[index] ?? [], needs))
  if (fits.length > 0) return { fits, ignored, closest: false, unmet: [] }

  // Nothing has every word: the nearest, and what they lack.
  const missing = all.map((index) => unmetNeeds(slotRows[index] ?? [], needs))
  const fewest = Math.min(...missing.map((list) => list.length))
  if (fewest >= needs.length) return { fits: [], ignored, closest: false, unmet: needs.map(needWord) }
  const nearest = all.filter((index) => (missing[index]?.length ?? 0) === fewest)
  const unmet = [...new Set(nearest.flatMap((index) => (missing[index] ?? []).map(needWord)))]
  return { fits: nearest, ignored, closest: true, unmet }
}

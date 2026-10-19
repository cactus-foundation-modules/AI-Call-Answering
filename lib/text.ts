// Small pure helpers for turning what a caller says, and what the shop stores,
// into something safe to compare or read aloud. No imports: everything here is
// unit-tested on its own.

/** A UK-style postcode reduced to what two spellings of it share: upper case,
 *  letters and digits only. "sw1a 1aa", "SW1A1AA" and "SW1A-1AA" all agree. */
export function normalisePostcode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const SPOKEN_CHARACTERS: Record<string, string> = {
  zero: '0', nought: '0', naught: '0', oh: 'O', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
  alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', golf: 'G',
  hotel: 'H', india: 'I', juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L', mike: 'M', november: 'N',
  oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R', sierra: 'S', tango: 'T', uniform: 'U', victor: 'V',
  whiskey: 'W', whisky: 'W', xray: 'X', yankee: 'Y', zulu: 'Z',
}

/** A postcode as the speech-to-text left it ("papa oh seven three delta lima",
 *  "double zero") turned back into characters. Words it does not know pass
 *  through untouched, so a plain "PO7 3DL" is unchanged. */
export function spokenPostcodeToText(value: string): string {
  const words = value.toLowerCase().split(/[\s,.-]+/).filter(Boolean)
  let out = ''
  for (let index = 0; index < words.length; index++) {
    const word = words[index] ?? ''
    if (word === 'double' || word === 'triple') {
      const next = SPOKEN_CHARACTERS[words[index + 1] ?? ''] ?? words[index + 1] ?? ''
      out += next.repeat(word === 'double' ? 2 : 3)
      index++
      continue
    }
    out += SPOKEN_CHARACTERS[word] ?? word
  }
  return out
}

const LOOKALIKE_DIGIT: Record<string, string> = { O: '0', I: '1', S: '5', B: '8', Z: '2', G: '6', Q: '0' }
const LOOKALIKE_LETTER: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G' }

/** A postcode with the characters a phone line confuses put where the postcode
 *  format says they must be. A UK postcode ends digit, letter, letter and starts
 *  with a letter, so "P073DL" heard for "PO7 3DL" gets its O back and both land
 *  on one key. Used only to COMPARE: never to display or to store. */
export function postcodeMatchKey(value: string): string {
  const plain = normalisePostcode(spokenPostcodeToText(value))
  if (plain.length < 5 || plain.length > 7) return plain
  const outward = plain.slice(0, -3)
  const inward = plain.slice(-3)
  const letterAt = (character: string) => LOOKALIKE_LETTER[character] ?? character
  const digitAt = (character: string) => LOOKALIKE_DIGIT[character] ?? character
  // After the first letter the outward code mixes letters and digits, so only
  // the two pairs that cannot change which district it is are folded.
  const outwardRest = outward.slice(1).replace(/O/g, '0').replace(/I/g, '1')
  return `${letterAt(outward.charAt(0))}${outwardRest}${digitAt(inward.charAt(0))}${letterAt(inward.charAt(1))}${letterAt(inward.charAt(2))}`
}

/** Whether two postcodes are the same one, allowing for what a phone line does
 *  to them: O for 0, I for 1 and the like, in places the format forbids. */
export function postcodesMatch(spoken: string, held: string): boolean {
  if (normalisePostcode(spoken) === normalisePostcode(held)) return true
  const spokenKey = postcodeMatchKey(spoken)
  const heldKey = postcodeMatchKey(held)
  if (spokenKey === heldKey) return true
  // One character out (a mis-heard letter, a dropped digit) on a full-length
  // postcode is still plainly that postcode.
  return spokenKey.length >= 6 && heldKey.length >= 6 && editDistance(spokenKey, heldKey) <= 1
}

/** Levenshtein distance: how many single-character edits turn `a` into `b`. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let row = 1; row <= a.length; row++) {
    const current = [row]
    for (let column = 1; column <= b.length; column++) {
      const cost = a.charAt(row - 1) === b.charAt(column - 1) ? 0 : 1
      current[column] = Math.min((previous[column] ?? 0) + 1, (current[column - 1] ?? 0) + 1, (previous[column - 1] ?? 0) + cost)
    }
    previous = current
  }
  return previous[b.length] ?? 0
}

/** An order number as a caller reads it out: "order DW 1042", "#dw-1042". Case
 *  and punctuation are dropped, so comparing two of them is comparing the
 *  characters that matter. */
export function normaliseOrderNumber(value: string): string {
  return value.toUpperCase().replace(/^ORDER(\s+NUMBER)?/, '').replace(/[^A-Z0-9]/g, '')
}

/** The letters and the number in an order number: "DW000123" is prefix "DW",
 *  number "123". The number is the trailing run of digits with leading zeros
 *  dropped; null when the order number does not end in digits. */
export function splitOrderNumber(value: string): { prefix: string; number: string } | null {
  const plain = normaliseOrderNumber(value)
  const match = /^([A-Z0-9]*?)(\d+)$/.exec(plain)
  if (!match) return null
  const number = (match[2] ?? '').replace(/^0+/, '')
  return number === '' ? null : { prefix: match[1] ?? '', number }
}

/** Whether a spoken order number is the held one. Exact once case and
 *  punctuation go, or the same number with padding zeros and the shop's
 *  prefix left off or put on: "dw000123" and "123" are order DW123. Two
 *  different prefixes are different orders. */
export function orderNumbersMatch(spoken: string, held: string): boolean {
  const spokenPlain = normaliseOrderNumber(spoken)
  if (spokenPlain === '') return false
  if (spokenPlain === normaliseOrderNumber(held)) return true
  const a = splitOrderNumber(spoken)
  const b = splitOrderNumber(held)
  if (!a || !b || a.number !== b.number) return false
  return a.prefix === b.prefix || a.prefix === '' || b.prefix === ''
}

/** Whether two email addresses are the same one allowing a mis-heard letter or
 *  two. Short addresses must be exact: a one-letter slip there is another
 *  person. */
export function emailsMatch(spoken: string, held: string): boolean {
  const a = spoken.trim().toLowerCase()
  const b = held.trim().toLowerCase()
  if (a === b) return true
  if (a === '' || b === '' || Math.min(a.length, b.length) < 10) return false
  return editDistance(a, b) <= (Math.max(a.length, b.length) >= 20 ? 2 : 1)
}

/** Whether two company names (already normalised) are the same one allowing
 *  for a slip of the ear or the keyboard. */
export function companiesMatch(spoken: string, held: string): boolean {
  if (spoken === '' || held === '') return false
  if (spoken === held) return true
  const longest = Math.max(spoken.length, held.length)
  if (Math.min(spoken.length, held.length) < 5) return false
  return 1 - editDistance(spoken, held) / longest >= 0.82
}

/** A phone number reduced to what the caller-ID form and the way orders store
 *  it share: its last ten digits. Caller ID arrives as "+447703822803" and an
 *  order holds "07703822803" or "07703 822 803", with or without the country
 *  code; the ten digits after the leading 0 are the same in all of them. Null
 *  when there are fewer than ten digits (withheld, or too short to trust). */
export function phoneMatchKey(value: string | null | undefined): string | null {
  const digits = (value ?? '').replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}

/** A company name with the noise that varies between how it is said and how it
 *  was typed at checkout: case, punctuation, a trailing Ltd or Limited. */
export function normaliseCompany(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\b(limited|ltd|plc|llp|inc|co|company)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function isPlausibleEmail(value: string): boolean {
  return value.length <= 320 && EMAIL_PATTERN.test(value)
}

/** Flattens stored markup or markdown to plain words for a model or a screen to
 *  read. Deliberately blunt: it is not a sanitiser, it is a reader. */
export function plainText(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** Shortens to `max` characters on a word boundary, with an ellipsis. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  const cut = value.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/** Splits a spoken search into the words worth matching on. Drops filler, caps
 *  the count so a rambling caller cannot build an enormous query. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'for', 'with', 'of', 'to', 'in', 'on', 'i', 'me', 'my', 'we', 'you',
  'some', 'any', 'want', 'need', 'looking', 'something', 'one', 'that', 'this', 'is', 'are', 'it',
])

export function searchTokens(query: string, limit = 6): string[] {
  const seen = new Set<string>()
  const tokens: string[] = []
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP_WORDS.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    tokens.push(raw)
    if (tokens.length >= limit) break
  }
  return tokens
}

/** Escapes % _ and \ so a spoken word is matched literally inside an ILIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

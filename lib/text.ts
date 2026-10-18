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
  return postcodeMatchKey(spoken) === postcodeMatchKey(held)
}

/** An order number as a caller reads it out: "order DW 1042", "#dw-1042". Case
 *  and punctuation are dropped, so comparing two of them is comparing the
 *  characters that matter. */
export function normaliseOrderNumber(value: string): string {
  return value.toUpperCase().replace(/^ORDER(\s+NUMBER)?/, '').replace(/[^A-Z0-9]/g, '')
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

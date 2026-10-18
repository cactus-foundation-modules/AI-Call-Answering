// Small pure helpers for turning what a caller says, and what the shop stores,
// into something safe to compare or read aloud. No imports: everything here is
// unit-tested on its own.

/** A UK-style postcode reduced to what two spellings of it share: upper case,
 *  letters and digits only. "sw1a 1aa", "SW1A1AA" and "SW1A-1AA" all agree. */
export function normalisePostcode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '')
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

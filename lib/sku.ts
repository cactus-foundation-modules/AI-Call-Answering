import { editDistance } from './text'

// ---------------------------------------------------------------------------
// Product codes (SKUs) as a caller reads them down a phone line.
//
// "O-P as in Oscar Papa, 000378" arrives as the model understood it, and a
// letter is easily heard as another ("el" for "oh"). So a code is compared the
// way an order number is: punctuation and case drop out, and a near-miss in the
// letters is still that code provided the digits agree.
// ---------------------------------------------------------------------------

const NATO: Record<string, string> = {
  ALPHA: 'A', ALFA: 'A', BRAVO: 'B', CHARLIE: 'C', DELTA: 'D', ECHO: 'E', FOXTROT: 'F', GOLF: 'G',
  HOTEL: 'H', INDIA: 'I', JULIET: 'J', JULIETT: 'J', KILO: 'K', LIMA: 'L', MIKE: 'M', NOVEMBER: 'N',
  OSCAR: 'O', PAPA: 'P', QUEBEC: 'Q', ROMEO: 'R', SIERRA: 'S', TANGO: 'T', UNIFORM: 'U', VICTOR: 'V',
  WHISKEY: 'W', WHISKY: 'W', XRAY: 'X', YANKEE: 'Y', ZULU: 'Z',
}

const DIGIT_WORDS: Record<string, string> = {
  ZERO: '0', OH: '0', NOUGHT: '0', ONE: '1', TWO: '2', THREE: '3', FOUR: '4', FIVE: '5',
  SIX: '6', SEVEN: '7', EIGHT: '8', NINE: '9',
}

/** A code with case, spaces, hyphens and spoken alphabet words ("oscar") reduced
 *  to the characters that matter: "o-p 000378" and "OP000378" are one code. */
export function normaliseSpokenSku(value: string): string {
  return value
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((word) => NATO[word] ?? DIGIT_WORDS[word] ?? word)
    .join('')
}

/** The trailing run of digits with leading zeros dropped, and the letters (and
 *  any other leading characters) before it: "OP000378" is "OP" and "378". Null
 *  when the code does not end in digits. */
export function splitSku(normalised: string): { prefix: string; digits: string } | null {
  const match = /^([A-Z0-9]*?)(\d+)$/.exec(normalised)
  if (!match) return null
  const digits = (match[2] ?? '').replace(/^0+/, '')
  return digits === '' ? null : { prefix: match[1] ?? '', digits }
}

/** The digits worth searching the catalogue for, or null for a code too short
 *  for the digits alone to mean anything. */
export function skuSearchDigits(normalised: string): string | null {
  const split = splitSku(normalised)
  return split && split.digits.length >= 3 ? split.digits : null
}

/** O for 0 and I for 1: the mix-ups a code read aloud is prone to. */
function confusionKey(value: string): string {
  return value.replace(/O/g, '0').replace(/I/g, '1')
}

export type SkuMatch = 'exact' | 'close' | null

/** Whether a spoken code is the held one. `exact` once case and punctuation go;
 *  `close` for the same digits with letters that are one slip away (or left off),
 *  which the assistant must confirm by name before relying on. */
export function skuMatch(spoken: string, held: string): SkuMatch {
  const a = normaliseSpokenSku(spoken)
  const b = normaliseSpokenSku(held)
  if (a === '' || b === '') return null
  if (a === b) return 'exact'
  if (confusionKey(a) === confusionKey(b)) return 'close'
  const splitA = splitSku(a)
  const splitB = splitSku(b)
  if (!splitA || !splitB || splitA.digits !== splitB.digits || splitA.digits.length < 3) return null
  if (splitA.prefix === '' || splitB.prefix === '') return 'close'
  return editDistance(splitA.prefix, splitB.prefix) <= 1 ? 'close' : null
}

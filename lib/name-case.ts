// A caller's name as an email greets them. Pure.
//
// Names arrive however they were typed or heard: "chris", "CHRIS",
// "mary-jane o'neil". The greeting should read "Hi Chris,", so each word typed
// in one case throughout is given a capital at its start and after each hyphen
// or apostrophe. A word that already has a capital inside it as well as small
// letters ("McDonald", "DeVries", "Mary-Jane") was typed with care and is left
// exactly as given.
//
// The chat assistant keeps its own copy (modules/ai-agent-for-live-chat/lib/
// name-case.ts), in step by hand: the two modules never import each other.

/** Whether a word has a capital after its first letter as well as small
 *  letters: typed with care. */
function typedWithCare(word: string): boolean {
  return /\p{Lu}/u.test(word.slice(1)) && /\p{Ll}/u.test(word)
}

/** A capital at the start and after each hyphen or apostrophe (straight or
 *  curly), small letters everywhere else. */
function capitalise(word: string): string {
  return word
    .toLocaleLowerCase('en-GB')
    .replace(/(^|['’-])(\p{L})/gu, (_match, before: string, letter: string) => `${before}${letter.toLocaleUpperCase('en-GB')}`)
}

/** "mary-jane o'neil" -> "Mary-Jane O'Neil", "CHRIS" -> "Chris"; "McDonald"
 *  and "DeVries" stay as they are. Spacing is tidied; an empty name stays
 *  empty. */
export function titleCaseName(raw: string | null | undefined): string {
  const name = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (!name) return ''
  return name.split(' ').map((word) => (typedWithCare(word) ? word : capitalise(word))).join(' ')
}

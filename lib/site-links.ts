import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Web addresses the assistant may send a caller.
//
// A caller asked for an article the founder wrote "on a text", then "on an
// email", and got "I can't send that one from here" twice: the send tools took
// product ids and nothing else. Now any page or article the shop publishes, and
// any link written into one, can go in a text or an email.
//
// The model never writes the address. It passes an id from search_pages or
// search_guides (or an address written word for word in the owner's own
// instructions), and the send tool looks it up among the shop's published links.
// Anything else is refused. A phone line is the easiest place on earth to talk a
// model into texting a stranger's link, so the list of addresses is the shop's,
// not the caller's.
// ---------------------------------------------------------------------------

export type RawLink = { label: string; href: string }
export type SiteLink = { id: string; label: string; url: string }

const LABEL_MAX = 120

/** A stable short id for an address: the same link has the same id on every
 *  call and survives the page being re-read. Pure. */
export function linkId(url: string): string {
  return `ln_${createHash('sha256').update(url).digest('hex').slice(0, 10)}`
}

/** An absolute http(s) address, or null for anything that is not a web page
 *  (mail, phone, in-page anchors, scripts). A path is joined to siteUrl. Pure. */
export function normaliseHref(href: string, siteUrl: string): string | null {
  const raw = href.trim().replace(/&amp;/g, '&')
  if (!raw || raw.startsWith('#')) return null
  const absolute = raw.startsWith('/') && !raw.startsWith('//')
    ? (siteUrl ? `${siteUrl.replace(/\/+$/, '')}${raw}` : null)
    : raw
  if (!absolute) return null
  let url: URL
  try {
    url = new URL(absolute)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  url.hash = ''
  return url.toString()
}

/** A raw link as one the send tools can use, or null when it is not a web
 *  page. A blank label falls back to the address's site name. Pure. */
export function siteLink(raw: RawLink, siteUrl: string): SiteLink | null {
  const url = normaliseHref(raw.href, siteUrl)
  if (!url) return null
  const label = raw.label.replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX) || new URL(url).hostname.replace(/^www\./, '')
  return { id: linkId(url), label, url }
}

/** Links written as HTML anchors in a string of copy. Pure. */
export function htmlLinks(html: string): RawLink[] {
  const links: RawLink[] = []
  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ href: match[2] ?? '', label: (match[3] ?? '').replace(/<[^>]+>/g, ' ') })
  }
  return links
}

/** Links written as markdown, [label](address), in a page kept as markdown. Pure. */
export function markdownLinks(markdown: string): RawLink[] {
  const links: RawLink[] = []
  for (const match of markdown.matchAll(/\[([^\]\n]{1,200})\]\(([^)\s]+)\)/g)) {
    links.push({ label: match[1] ?? '', href: match[2] ?? '' })
  }
  return links
}

/** Web addresses written out in plain text (the owner's instructions), as
 *  links labelled by their site. Trailing sentence punctuation is not part of
 *  the address. Pure. */
export function plainTextLinks(text: string): SiteLink[] {
  const links: SiteLink[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const link = siteLink({ label: '', href: match[0].replace(/[.,;:!?)\]]+$/, '') }, '')
    if (link && !links.some((known) => known.id === link.id)) links.push(link)
  }
  return links
}

export type LinkPick = { links: SiteLink[]; unknown: number }

/** The links the model asked for, in its order, each found in known by id or
 *  by its exact address; anything not there is counted, never sent. Pure. */
export function pickLinks(asked: readonly string[], known: ReadonlyMap<string, SiteLink>, max: number): LinkPick {
  const links: SiteLink[] = []
  let unknown = 0
  for (const entry of asked) {
    const ref = entry.trim()
    if (!ref) continue
    const address = /^https?:\/\//i.test(ref) ? normaliseHref(ref, '') : null
    const link = known.get(ref) ?? (address ? known.get(linkId(address)) : undefined)
    if (!link) {
      unknown += 1
      continue
    }
    if (!links.some((chosen) => chosen.id === link.id)) links.push(link)
  }
  return { links: links.slice(0, max), unknown }
}

/** The sentence a send tool adds when some links were not the shop's own. */
export function unknownLinksMessage(unknown: number): string {
  if (unknown === 0) return ''
  return `${unknown === 1 ? 'One link was' : `${unknown} links were`} left out because it is not on the shop's pages or in your instructions: use the link ids search_pages or search_guides gave you, and never make up a web address.`
}

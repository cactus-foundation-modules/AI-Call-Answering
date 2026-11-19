import { describe, expect, it } from 'vitest'
import { htmlLinks, linkId, markdownLinks, normaliseHref, pickLinks, plainTextLinks, siteLink, unknownLinksMessage, type SiteLink } from './site-links'

const SITE = 'https://shop.example'
const ARTICLE = 'https://workplaceinsight.net/the-office-furniture-price-on-the-page-has-always-been-an-opening-bid/'

describe('normaliseHref', () => {
  it('joins a path to the site', () => {
    expect(normaliseHref('/returns', SITE)).toBe('https://shop.example/returns')
  })
  it('keeps an outside article whole, minus any in-page anchor', () => {
    expect(normaliseHref(`${ARTICLE}#comments`, SITE)).toBe(ARTICLE)
  })
  it('refuses anything that is not a web page', () => {
    expect(normaliseHref('mailto:hello@shop.example', SITE)).toBeNull()
    expect(normaliseHref('tel:+441234567890', SITE)).toBeNull()
    expect(normaliseHref('javascript:alert(1)', SITE)).toBeNull()
    expect(normaliseHref('#top', SITE)).toBeNull()
    expect(normaliseHref('not a link', SITE)).toBeNull()
  })
  it('cannot resolve a path without a site', () => {
    expect(normaliseHref('/returns', '')).toBeNull()
  })
})

describe('siteLink', () => {
  it('gives the same id every time for the same address', () => {
    const one = siteLink({ label: 'Workplace Insight', href: ARTICLE }, SITE)
    const two = siteLink({ label: 'another label', href: ARTICLE }, SITE)
    expect(one?.id).toBe(two?.id)
    expect(one?.id).toBe(linkId(ARTICLE))
  })
  it('labels a bare link with its site name', () => {
    expect(siteLink({ label: '  ', href: 'https://www.example.org/x' }, SITE)?.label).toBe('example.org')
  })
})

describe('reading links out of copy', () => {
  it('finds HTML anchors with their words', () => {
    expect(htmlLinks('<p>Read <a href="/returns" target="_blank">our <b>returns</b> page</a>.</p>')).toEqual([
      { href: '/returns', label: 'our  returns  page' },
    ])
  })
  it('finds markdown links', () => {
    expect(markdownLinks('See [the delivery page](/delivery) for more.')).toEqual([{ label: 'the delivery page', href: '/delivery' }])
  })
  it('finds addresses written out in plain text, without the full stop', () => {
    const links = plainTextLinks(`Chris wrote for Workplace Insight: ${ARTICLE}. Mention it.`)
    expect(links.map((link) => link.url)).toEqual([ARTICLE])
  })
})

describe('pickLinks', () => {
  const article: SiteLink = { id: linkId(ARTICLE), label: 'Workplace Insight', url: ARTICLE }
  const known = new Map([[article.id, article]])

  it('finds a link by id or by its exact address', () => {
    expect(pickLinks([article.id], known, 3).links).toEqual([article])
    expect(pickLinks([ARTICLE], known, 3).links).toEqual([article])
  })
  it('never sends an address that is not the shop\'s', () => {
    const pick = pickLinks(['https://evil.example/phish', 'ln_0000000000'], known, 3)
    expect(pick.links).toEqual([])
    expect(pick.unknown).toBe(2)
  })
  it('sends each link once, and no more than asked', () => {
    expect(pickLinks([article.id, ARTICLE, article.id], known, 3).links).toHaveLength(1)
    expect(pickLinks([article.id], known, 0).links).toHaveLength(0)
  })
  it('explains a link left out', () => {
    expect(unknownLinksMessage(0)).toBe('')
    expect(unknownLinksMessage(1)).toContain('One link was left out')
  })
})

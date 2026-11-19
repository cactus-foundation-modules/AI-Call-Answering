import { describe, expect, it } from 'vitest'
import { extractChunks, rankPassages, toPassages } from './site-content'

const page = {
  root: { props: { title: 'Returns', slug: 'returns' } },
  content: [
    { type: 'Heading', props: { id: 'h1', text: 'Something damaged or faulty', size: 'lg' } },
    {
      type: 'RichText',
      props: {
        id: 'r1',
        align: 'left',
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Report it on your order within 5 days with photographs.' }] }] },
      },
    },
    { type: 'Heading', props: { id: 'h2', text: 'Changed your mind', size: 'lg' } },
    { type: 'Text', props: { id: 't1', text: '<p>You have 14 days to ask for a return.</p>', visible: 'false' } },
  ],
}

describe('site content search', () => {
  const passages = toPassages('Returns & Cancellations', extractChunks(page))

  it('walks nested rich text and keeps headings, skipping settings', () => {
    expect(passages).toEqual([
      { source: 'Returns & Cancellations', heading: 'Something damaged or faulty', text: 'Report it on your order within 5 days with photographs.' },
      { source: 'Returns & Cancellations', heading: 'Changed your mind', text: 'You have 14 days to ask for a return.' },
    ])
  })

  it('finds the passage for the question, plurals included', () => {
    expect(rankPassages(passages, 'where do I upload a photo of the damage')[0]!.heading).toBe('Something damaged or faulty')
  })

  it('finds nothing for a question with no matching words', () => {
    expect(rankPassages(passages, 'parking')).toEqual([])
  })
})

describe('links in site content', () => {
  const article = {
    content: [
      { type: 'Heading', props: { id: 'h1', text: 'Who wrote it' } },
      {
        type: 'RichText',
        props: {
          id: 'r1',
          content: {
            type: 'doc',
            content: [{
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Chris also wrote the trade-side argument for ' },
                { type: 'text', text: 'Workplace Insight', marks: [{ type: 'link', attrs: { href: 'https://workplaceinsight.net/opening-bid/', target: '_blank' } }] },
                { type: 'text', text: ' this week.' },
              ],
            }],
          },
        },
      },
      { type: 'Button', props: { id: 'b1', label: 'Report a problem', href: '/returns' } },
      { type: 'Text', props: { id: 't1', text: '<p>Write to us at <a href="mailto:hi@shop.example">our inbox</a> any time.</p>' } },
    ],
  }
  const passages = toPassages('How to read a price', extractChunks(article), 'https://shop.example')

  it('keeps each link with the passage it is written in, by label', () => {
    expect(passages).toHaveLength(1)
    expect(passages[0]!.links?.map((link) => [link.label, link.url])).toEqual([
      ['Workplace Insight', 'https://workplaceinsight.net/opening-bid/'],
      ['Report a problem', 'https://shop.example/returns'],
    ])
  })

  it('reads a button label once, not twice', () => {
    expect(passages[0]!.text.match(/Report a problem/g)).toHaveLength(1)
  })

  it('finds the passage by the name of the site it links to', () => {
    expect(rankPassages(passages, 'workplace insight article')[0]?.links?.[0]?.label).toBe('Workplace Insight')
  })
})

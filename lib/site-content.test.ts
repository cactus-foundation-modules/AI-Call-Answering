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

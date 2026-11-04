import { describe, expect, it } from 'vitest'
import { expandSearchWords, nearbyWords, spellingVariants, textHasWord } from './spelling'

describe('spellingVariants', () => {
  it('finds lite from light and light from lite', () => {
    expect(spellingVariants('light')).toContain('lite')
    expect(spellingVariants('lite')).toContain('light')
  })
  it('crosses the British and American spellings', () => {
    expect(spellingVariants('color')).toContain('colour')
    expect(spellingVariants('grey')).toContain('gray')
    expect(spellingVariants('organise')).toContain('organize')
  })
  it('tries the plural and the singular', () => {
    expect(spellingVariants('chairs')).toContain('chair')
    expect(spellingVariants('desk')).toContain('desks')
  })
  it('always starts with the word as heard and stays short', () => {
    const variants = spellingVariants('Light')
    expect(variants[0]).toBe('light')
    expect(variants.length).toBeLessThanOrEqual(8)
  })
})

describe('nearbyWords', () => {
  const vocabulary = new Set(['ergonomic', 'chair', 'desk', 'headrest'])
  it('forgives a slip in a longer word', () => {
    expect(nearbyWords('ergonomik', vocabulary)).toEqual(['ergonomic'])
  })
  it('leaves a word that is already the shop\'s alone', () => {
    expect(nearbyWords('chair', vocabulary)).toEqual([])
  })
  it('does not guess at short words', () => {
    expect(nearbyWords('dusk', vocabulary)).toEqual([])
  })
})

describe('expandSearchWords', () => {
  it('widens every word to its spellings', () => {
    const [first] = expandSearchWords(['light'], null)
    expect(first).toEqual(expect.arrayContaining(['light', 'lite']))
  })
  it('joins words the shop writes as one', () => {
    const words = expandSearchWords(['head', 'rest'], new Set(['headrest']))
    expect(words[0]).toContain('headrest')
    expect(words[1]).toContain('headrest')
  })
  it('splits a word the shop writes as two', () => {
    const words = expandSearchWords(['bookcase'], new Set(['book', 'case']))
    expect(words[0]).toContain('book case')
  })
  it('corrects a slip using the shop vocabulary', () => {
    const words = expandSearchWords(['ergonomik'], new Set(['ergonomic']))
    expect(words[0]).toContain('ergonomic')
  })
})

describe('textHasWord', () => {
  it('matches under any spelling', () => {
    expect(textHasWord('Lite Grey / Black', spellingVariants('light'))).toBe(true)
    expect(textHasWord('Dark Blue', spellingVariants('light'))).toBe(false)
  })
})

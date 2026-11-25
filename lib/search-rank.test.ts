import { describe, expect, it } from 'vitest'
import { headNoun, rankProducts, type IndexedProduct } from './search-rank'

function product(id: string, fields: Partial<IndexedProduct>): IndexedProduct {
  return { id, name: '', variants: '', category: '', body: '', categoryIds: [], popularity: 0, ...fields }
}

const INDEX = [
  product('qube', { name: 'qube steel office filing cabinet', category: 'filing cabinets', categoryIds: ['storage'] }),
  product('castors', { name: 'brunswick office chair castors', body: 'fits our chairs, not our filing cabinets', categoryIds: ['parts'] }),
  product('crew', { name: 'crew 2 mesh back task office chair', variants: 'black myrrh green', category: 'computer & task chairs', categoryIds: ['task'] }),
  product('rowan', { name: 'rowan high back office chair', body: 'available in green', category: 'computer & task chairs', categoryIds: ['task'], popularity: 9 }),
  product('oslo', { name: 'oslo air electric height adjustable standing desk', variants: '120cm black white', body: 'black top with a natural wood edge', categoryIds: ['desks'] }),
  product('clamp', { name: 'desk screen clamps', variants: 'black', categoryIds: ['parts'] }),
  product('frame', { name: 'qube a4 filing frame', body: 'fits any qube cabinet', categoryIds: ['storage'] }),
  product('arms', { name: 'height adjustable office chair arms', variants: 'black', body: 'for any desk height', categoryIds: ['parts'] }),
  product('meeting', { name: 'cosmo meeting chair', variants: 'black green', categoryIds: ['meeting'] }),
]

const w = (...words: string[]) => words.map((word) => [word])

describe('rankProducts', () => {
  it('needs every word, and ranks a hit in the variations above one in the blurb', () => {
    expect(rankProducts(INDEX, w('green', 'chair'), { categoryIds: null, sort: 'relevance', limit: 6 })).toEqual({ ids: ['meeting', 'crew', 'rowan'], loosened: false })
  })

  it('ignores a word half the catalogue carries when choosing what to price', () => {
    const ids = rankProducts(INDEX, w('green', 'office', 'chair'), { categoryIds: null, sort: 'price', limit: 6 }).ids
    expect(ids).toEqual(['crew'])
  })

  it('prices, for a long description, the products with the most of it in their name and options', () => {
    expect(rankProducts(INDEX, w('height', 'adjustable', 'desk', 'black', 'wooden', 'edge'), { categoryIds: null, sort: 'price', limit: 6 }).ids).toEqual(['oslo'])
  })

  it('prices only the strong matches for "the cheapest"', () => {
    expect(rankProducts(INDEX, w('filing', 'cabinet'), { categoryIds: null, sort: 'price', limit: 6 }).ids).toEqual(['qube'])
    expect(rankProducts(INDEX, w('filing', 'cabinet'), { categoryIds: null, sort: 'relevance', limit: 6 }).ids).toEqual(['qube', 'frame', 'castors'])
  })

  it('loosens to the products with the most words, never to any single word', () => {
    expect(rankProducts(INDEX, w('height', 'adjustable', 'desk', 'black', 'wooden', 'edge'), { categoryIds: null, sort: 'relevance', limit: 6 }))
      .toEqual({ ids: ['oslo'], loosened: true })
    expect(rankProducts(INDEX, w('purple', 'sofa', 'desk'), { categoryIds: null, sort: 'relevance', limit: 6 }).ids).toEqual([])
  })

  it('keeps to the category given, and lists it by popularity with no words', () => {
    expect(rankProducts(INDEX, w('green'), { categoryIds: new Set(['task']), sort: 'relevance', limit: 6 }).ids).toEqual(['crew', 'rowan'])
    expect(rankProducts(INDEX, [], { categoryIds: new Set(['task']), sort: 'relevance', limit: 6 }).ids).toEqual(['rowan', 'crew'])
  })

  it('prices only what the product IS when any match (the live-site desk screens and clamps)', () => {
    const index = [
      product('desk', { name: 'impulse cantilever rectangular office desk', head: 'desk', variants: '120cm dark teal blue', body: 'an office desk' }),
      product('clamps', { name: 'small c-style desk screen clamps', head: 'clamps', variants: '120cm', body: 'for office desks' }),
      product('screen', { name: 'sch! wave acoustic desktop side screen desk divider', head: 'divider', variants: 'cobalt blue 120cm', body: 'office desk screen' }),
    ]
    expect(rankProducts(index, w('blue', 'office', 'desk', '120cm'), { categoryIds: null, sort: 'price', limit: 6 }).ids).toEqual(['desk'])
    expect(rankProducts(index, w('desk', '120cm'), { categoryIds: null, sort: 'relevance', limit: 6 }).ids[0]).toBe('desk')
  })
})

describe('headNoun', () => {
  it('reads what a product is from its name', () => {
    expect(headNoun('Impulse Cantilever Rectangular Office Desk')).toBe('desk')
    expect(headNoun('Small C-Style Desk Screen Clamps, Set of 2')).toBe('clamps')
    expect(headNoun('Qube Steel Office Filing Cabinet in 25 Colours')).toBe('cabinet')
    expect(headNoun('Volta Round Cable Port Power Module with Mains Socket and 45W USB')).toBe('module')
    expect(headNoun('Crew 2 Mesh Back Task Operator Office Chair with Folding Arms')).toBe('chair')
  })
})

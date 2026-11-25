import { describe, expect, it } from 'vitest'
import {
  addressKey,
  markEmailed,
  markLinked,
  shownByTool,
  MAX_DISCUSSED_PRODUCTS,
  addressOf,
  addressWithChoice,
  chooseDelivery,
  chosenDeliveries,
  fromProductDetail,
  fromSkuHits,
  parseDiscussedProducts,
  productLinksToSend,
  productsToSend,
  recordedEntry,
  rememberProducts,
  type DiscussedProduct,
} from './discussed-products'

// What a chat remembers it was about, and what a note or a text lists from it.

const desk: DiscussedProduct = { id: 'desk', url: 'https://shop.test/desk', parentId: null }
const deskBlack: DiscussedProduct = { id: 'desk-black', url: 'https://shop.test/desk?colour=black', parentId: 'desk' }
const chair: DiscussedProduct = { id: 'chair', url: 'https://shop.test/chair', parentId: null }

describe('what the product tools record', () => {
  it('get_product: the one variation that matched, else the product itself', () => {
    const named = { id: 'desk', name: 'Desk', url: desk.url }
    expect(fromProductDetail({ ...named, matchingVariations: [{ id: 'desk-black', url: deskBlack.url }] })).toEqual([{ ...deskBlack, name: 'Desk' }])
    expect(fromProductDetail({ ...named, matchingVariations: null })).toEqual([{ ...desk, name: 'Desk' }])
    expect(fromProductDetail({ ...named, matchingVariations: [{ id: 'a', url: null }, { id: 'b', url: null }] })).toEqual([{ ...desk, name: 'Desk' }])
  })

  it('find_by_sku: the one hit, or the one exact hit, never a guess among several', () => {
    const variation = { productId: 'desk', name: 'Desk', url: deskBlack.url, match: 'exact' as const, variation: { id: 'desk-black' } }
    const close = { productId: 'chair', name: 'Chair', url: chair.url, match: 'close' as const, variation: null }
    expect(fromSkuHits([variation])).toEqual([{ ...deskBlack, name: 'Desk' }])
    expect(fromSkuHits([variation, close])).toEqual([{ ...deskBlack, name: 'Desk' }])
    expect(fromSkuHits([close])).toEqual([{ ...chair, name: 'Chair' }])
    expect(fromSkuHits([close, { ...close, productId: 'stool' }])).toEqual([])
    expect(fromSkuHits([])).toEqual([])
  })
})

describe('rememberProducts', () => {
  it('keeps the newest last, moving a repeat to the end', () => {
    expect(rememberProducts([desk, chair], [desk]).map((p) => p.id)).toEqual(['chair', 'desk'])
  })

  it('lets a chosen variation replace its listing', () => {
    expect(rememberProducts([desk, chair], [deskBlack]).map((p) => p.id)).toEqual(['chair', 'desk-black'])
  })

  it('brings the chosen variation forward when its listing is read again', () => {
    expect(rememberProducts([deskBlack, chair], [desk]).map((p) => p.id)).toEqual(['chair', 'desk-black'])
  })

  it('keeps only the newest ten', () => {
    const many = Array.from({ length: MAX_DISCUSSED_PRODUCTS + 4 }, (_, i) => ({ id: `p${i}`, url: null, parentId: null }))
    const kept = rememberProducts([], many)
    expect(kept).toHaveLength(MAX_DISCUSSED_PRODUCTS)
    expect(kept[kept.length - 1]?.id).toBe(`p${MAX_DISCUSSED_PRODUCTS + 3}`)
  })
})

describe('parseDiscussedProducts', () => {
  it('reads the stored list and drops anything without an id', () => {
    expect(parseDiscussedProducts([{ id: 'desk', url: desk.url }, { url: 'x' }, 'chair', null, { id: ' ', url: null }])).toEqual([desk])
    expect(parseDiscussedProducts({})).toEqual([])
    expect(parseDiscussedProducts(null)).toEqual([])
  })
})

describe('productsToSend (the live-site bug: a note with no products)', () => {
  it('falls back to the chat\'s own record, newest first, when the model passes none', () => {
    expect(productsToSend([], [chair, deskBlack], 5)).toEqual(['desk-black', 'chair'])
  })

  it('uses the ids the model passed when it passed any', () => {
    expect(productsToSend(['chair'], [chair, deskBlack], 5)).toEqual(['chair'])
  })

  it('swaps a listing the model named for the variation the chat settled on', () => {
    expect(productsToSend(['desk', 'chair'], [deskBlack, chair], 5)).toEqual(['desk-black', 'chair'])
  })

  it('never lists more than asked, never twice, and nothing when nothing was discussed', () => {
    expect(productsToSend([], [desk, chair, deskBlack], 1)).toEqual(['desk-black'])
    expect(productsToSend(['chair', 'chair', ' '], [], 5)).toEqual(['chair'])
    expect(productsToSend([], [], 5)).toEqual([])
  })
})

const urls = (links: ReadonlyArray<{ url: string }>) => links.map((link) => link.url)

describe('productLinksToSend', () => {
  it('links only products the chat recorded, the named ones first', () => {
    expect(urls(productLinksToSend(['chair', 'invented'], [chair, deskBlack], 3))).toEqual([chair.url])
    expect(urls(productLinksToSend(['desk'], [chair, deskBlack], 3))).toEqual([deskBlack.url])
  })

  it('falls back to the newest recorded when none named are known', () => {
    expect(urls(productLinksToSend(['invented'], [chair, deskBlack], 3))).toEqual([deskBlack.url, chair.url])
    expect(urls(productLinksToSend([], [chair, deskBlack, { id: 'x', url: null, parentId: null }], 1))).toEqual([deskBlack.url])
  })
})

describe('a chosen delivery service', () => {
  const express = { key: 'express', label: 'Express' }
  const installed = { key: 'installed', label: 'Delivered and installed' }

  it('reads rows saved before deliveries were kept exactly as before', () => {
    const old = [{ id: 'desk-black', url: deskBlack.url, parentId: 'desk' }, { id: 'chair', url: chair.url, parentId: null }]
    expect(parseDiscussedProducts(old)).toEqual([deskBlack, chair])
    expect(parseDiscussedProducts(old)[0]).not.toHaveProperty('delivery')
  })

  it('reads a stored choice back, and drops one that is not a real key and name', () => {
    expect(parseDiscussedProducts([{ ...deskBlack, delivery: express }])).toEqual([{ ...deskBlack, delivery: express }])
    expect(parseDiscussedProducts([{ ...deskBlack, delivery: { key: 'bad key!', label: 'Express' } }])).toEqual([deskBlack])
    expect(parseDiscussedProducts([{ ...deskBlack, delivery: { key: 'express' } }])).toEqual([deskBlack])
    expect(parseDiscussedProducts([{ ...deskBlack, delivery: 'express' }])).toEqual([deskBlack])
  })

  it('is recorded on the entry, which becomes the newest, and a new choice replaces it', () => {
    const once = chooseDelivery([deskBlack, chair], 'desk-black', express)
    expect(once).toEqual([chair, { ...deskBlack, delivery: express }])
    const twice = chooseDelivery(once, 'desk-black', installed)
    expect(twice).toEqual([chair, { ...deskBlack, delivery: installed }])
  })

  it('is not recorded for a product the chat never looked up', () => {
    expect(chooseDelivery([chair], 'invented', express)).toEqual([chair])
  })

  it('survives the product being looked up again, but is not handed from a listing to its variation', () => {
    const chosen = chooseDelivery([desk, chair], 'desk', express)
    expect(rememberProducts(chosen, [desk])).toEqual([chair, { ...desk, delivery: express }])
    expect(rememberProducts(chosen, [deskBlack])).toEqual([chair, deskBlack])
    const variation = chooseDelivery([deskBlack], 'desk-black', express)
    expect(rememberProducts(variation, [desk])).toEqual([{ ...deskBlack, delivery: express }])
  })

  it('finds the entry a product id means: itself, or the variation the chat settled on', () => {
    expect(recordedEntry([deskBlack, chair], 'chair')).toBe(chair)
    expect(recordedEntry([deskBlack, chair], 'desk')).toBe(deskBlack)
    expect(recordedEntry([deskBlack, chair], 'invented')).toBeUndefined()
    expect(recordedEntry([deskBlack], ' ')).toBeUndefined()
  })

  it('puts the service on the address, the options kept, and on a text\'s links', () => {
    const chosen = chooseDelivery([chair, deskBlack], 'desk-black', express)
    expect(addressOf(chosen[1]!)).toBe('https://shop.test/desk?colour=black&delivery-service=express')
    expect(addressOf(chair)).toBe(chair.url)
    expect(addressWithChoice('desk-black', deskBlack.url, chosen)).toBe('https://shop.test/desk?colour=black&delivery-service=express')
    expect(addressWithChoice('desk', desk.url, chosen)).toBe(desk.url)
    expect(urls(productLinksToSend([], chosen, 3))).toEqual(['https://shop.test/desk?colour=black&delivery-service=express', chair.url])
    expect(chosenDeliveries(chosen)).toEqual(new Map([['desk-black', express]]))
  })
})

describe('what the assistant showed (the live-site bug: an email of the wrong products)', () => {
  const rowan = { id: 'rowan-green', url: 'https://shop.test/rowan?colour=myrrh-green', parentId: 'rowan', name: 'Rowan' }
  const cabinet = { id: 'qube', url: 'https://shop.test/qube', parentId: null, name: 'Qube' }
  const crew = { id: 'crew-green', url: 'https://shop.test/crew?upholstery-colour=myrrh-green', parentId: 'crew', name: 'Crew 2' }

  it('compares addresses however they are spelled', () => {
    expect(addressKey('https://www.Shop.test/crew/?b=2&a=1&delivery-service=express&utm_source=x')).toBe('shop.test/crew?a=1&b=2')
    expect(addressKey('not an address')).toBeNull()
  })

  it('marks what a reply shows, adding a search result the chat never recorded', () => {
    const shown = shownByTool([{ id: 'qube', name: 'Qube', url: cabinet.url }])
    const after = markLinked([rowan, crew], shown, `The Qube is the cheapest.\n\nhttps://shop.test/qube.`)
    expect(after).toEqual([rowan, crew, { ...cabinet, linked: true }])
  })

  it('leaves the record alone when the reply shows nothing it knows', () => {
    expect(markLinked([rowan], [], 'No links here.')).toEqual([rowan])
    expect(markLinked([rowan], [], 'See https://elsewhere.example/x')).toEqual([rowan])
  })

  it('sends only what was shown when nothing is named, newest first, with names for a text', () => {
    let list = markLinked([rowan, crew], [], crew.url)
    list = markLinked(list, shownByTool([{ id: 'qube', name: 'Qube', url: cabinet.url }]), cabinet.url)
    expect(productsToSend([], list, 5)).toEqual(['qube', 'crew-green'])
    expect(productLinksToSend([], list, 3)).toEqual([{ label: 'Qube', url: cabinet.url }, { label: 'Crew 2', url: crew.url }])
  })

  it('carries "shown" and the name from a listing to the variation later chosen for it', () => {
    const desk = { id: 'desk', url: 'https://shop.test/desk', parentId: null, name: 'Oslo Air', linked: true }
    const chosen = rememberProducts([desk], [{ id: 'desk-120-black', url: 'https://shop.test/desk?width=120cm', parentId: 'desk' }])
    expect(chosen).toEqual([{ id: 'desk-120-black', url: 'https://shop.test/desk?width=120cm', parentId: 'desk', name: 'Oslo Air', linked: true }])
  })

  it('reads the name and the shown mark back from storage', () => {
    expect(parseDiscussedProducts([{ ...crew, linked: true }, { ...cabinet, linked: 'yes' }])).toEqual([{ ...crew, linked: true }, cabinet])
  })
})

describe('a partial choice (the live-site yellow chair)', () => {
  const full = { id: 'eclipse-yellow-noarms', url: 'https://shop.test/eclipse?arms=no-arms&seat=senna-yellow', parentId: 'eclipse', name: 'Eclipse', linked: true }
  const partial = { id: 'eclipse', url: 'https://shop.test/eclipse?seat=senna-yellow', parentId: null, name: 'Eclipse', picks: 'seat.senna-yellow' }

  it('get_product: the listing with just the options chosen, when several fit', () => {
    expect(fromProductDetail({ id: 'eclipse', name: 'Eclipse', url: 'https://shop.test/eclipse', matchingVariations: [{ id: 'a', url: null }, { id: 'b', url: null }], chosenOptions: { url: partial.url, picks: partial.picks } }))
      .toEqual([partial])
  })

  it('replaces a fully chosen variation the visitor never asked for, keeping "shown"', () => {
    expect(rememberProducts([full], [partial])).toEqual([{ ...partial, linked: true }])
  })

  it('survives the listing being read again with no new choice', () => {
    expect(rememberProducts([partial], [{ id: 'eclipse', url: 'https://shop.test/eclipse', parentId: null, name: 'Eclipse' }])).toEqual([partial])
  })

  it('gives way to a variation chosen later', () => {
    expect(rememberProducts([partial], [full]).map((e) => e.id)).toEqual(['eclipse-yellow-noarms'])
  })

  it('reads back, and only on a listing', () => {
    expect(parseDiscussedProducts([partial])).toEqual([partial])
    expect(parseDiscussedProducts([{ ...full, picks: 'seat.senna-yellow' }])).toEqual([full])
    expect(parseDiscussedProducts([{ ...partial, picks: 'seat=yellow' }])).toEqual([{ ...partial, picks: undefined }].map(({ picks: _p, ...rest }) => rest))
  })

  it('a search result shown with only some options picked is recorded that way', () => {
    const shown = shownByTool([{ id: 'eclipse', name: 'Eclipse', url: 'https://shop.test/eclipse', partial: { url: partial.url, picks: partial.picks } }])
    expect(markLinked([], shown, `Here it is:\n${partial.url}`)).toEqual([{ ...partial, linked: true }])
  })
})

describe('markEmailed', () => {
  it('marks only the products that went, and keeps the mark when a product is read again', () => {
    const a = { id: 'a', url: 'https://shop.test/a', parentId: null, name: 'A' }
    const b = { id: 'b', url: 'https://shop.test/b', parentId: null, name: 'B' }
    const sent = markEmailed([a, b], ['a'])
    expect(sent).toEqual([{ ...a, emailed: true }, b])
    expect(rememberProducts(sent, [a]).find((e) => e.id === 'a')?.emailed).toBe(true)
    expect(parseDiscussedProducts([{ ...a, emailed: true }])).toEqual([{ ...a, emailed: true }])
  })
})

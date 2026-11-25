import { describe, expect, it } from 'vitest'
import { matchWords, pickVariations, type VariationCandidate } from './variation-match'

const NAMES = ['Width', 'Modesty Panel', 'Finish', 'Frame Colour']

/** The Oslo Air desk as the live shop lists it: 3 widths, with or without a
 *  modesty panel, two finishes ("Black" is the black top with a wooden edge)
 *  and three frame colours. */
function osloAir(): VariationCandidate[] {
  const rows: VariationCandidate[] = []
  for (const width of ['120cm', '140cm', '160cm']) {
    for (const panel of ['Without Modesty Panel', 'With Modesty Panel']) {
      for (const finish of ['White', 'Black']) {
        for (const frame of ['White', 'Black', 'Silver']) {
          rows.push({ optionNames: NAMES, optionValues: [width, panel, finish, frame], name: `Oslo Air ${width}` })
        }
      }
    }
  }
  return rows
}

function picked(wanted: string, rows = osloAir()) {
  const result = pickVariations(wanted, rows)
  return { ...result, values: result.fits.map((index) => rows[index]?.optionValues.join(' / ')) }
}

describe('matchWords', () => {
  it('folds every negation into "without" and splits sizes', () => {
    expect(matchWords('120x80cm, no mod panel')).toEqual(['120', '80', 'without', 'mod', 'panel'])
    expect(matchWords('w/o arms, not black')).toEqual(['without', 'arms', 'without', 'black'])
  })
})

describe('pickVariations', () => {
  it('reads "no mod panel" as Without Modesty Panel and binds a colour to the option it names', () => {
    const result = picked('120cm, no mod panel, black frame')
    expect(result.values).toEqual([
      '120cm / Without Modesty Panel / White / Black',
      '120cm / Without Modesty Panel / Black / Black',
    ])
    expect(result.closest).toBe(false)
  })

  it('sets aside words no variation carries instead of failing on them', () => {
    const result = picked('120cm black top with natural wood edge, black frame, without modesty panel')
    expect(result.values).toEqual(['120cm / Without Modesty Panel / Black / Black'])
    expect(result.ignored).toEqual(['top', 'natural', 'wood', 'edge'])
  })

  it('needs a slot for each time a word is said', () => {
    expect(picked('120 black black without modesty').values).toEqual(['120cm / Without Modesty Panel / Black / Black'])
  })

  it('lets one free colour fit either option', () => {
    expect(picked('160 with modesty panel black').fits).toHaveLength(4)
  })

  it('keeps "with" and "without" apart', () => {
    const withPanel = picked('140 with modesty panel white white')
    expect(withPanel.values).toEqual(['140cm / With Modesty Panel / White / White'])
    const without = picked('140 without modesty panel white white')
    expect(without.values).toEqual(['140cm / Without Modesty Panel / White / White'])
  })

  it('treats a "with" that names no "With ..." value as an ordinary word', () => {
    const result = picked('black top with natural wood edge')
    expect(result.fits.length).toBeGreaterThan(1)
    expect(result.closest).toBe(false)
  })

  it('reads option-name words as narrowing nothing', () => {
    expect(picked('frame finish width').fits).toHaveLength(36)
    expect(picked('frame finish width').ignored).toEqual([])
  })

  it('returns the nearest variations, and what they miss, when nothing has every word', () => {
    const result = picked('120 silver silver')
    expect(result.closest).toBe(true)
    expect(result.unmet).toEqual(['silver'])
    expect(result.values.every((value) => value?.startsWith('120cm') && value.endsWith('Silver'))).toBe(true)
  })

  it('matches a product with no options on its name', () => {
    const rows = [{ optionNames: [], optionValues: [], name: 'Green Mesh Chair' }, { optionNames: [], optionValues: [], name: 'Blue Mesh Chair' }]
    expect(pickVariations('green', rows).fits).toEqual([0])
  })

  it('folds "No Arms" in a label the same way', () => {
    const rows = ['No Arms', 'Fixed Arms', 'Folding Arms'].map((arms) => ({ optionNames: ['Arms'], optionValues: [arms], name: arms }))
    expect(pickVariations('without arms', rows).fits).toEqual([0])
    expect(pickVariations('no arms', rows).fits).toEqual([0])
    expect(pickVariations('folding arms', rows).fits).toEqual([2])
  })
})

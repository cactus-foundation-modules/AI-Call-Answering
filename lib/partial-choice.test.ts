import { describe, expect, it } from 'vitest'
import { carryChoices, choicesInAddress, parsePicksRef, picksRef, settledOptions, type OptionPick } from './partial-choice'

/** An Eclipse-style chair: adjustments, arms, seat colour, back. */
function chair(adjust: string, arms: string, seat: string): OptionPick[] {
  return [
    ['Adjustments', adjust, adjust],
    ['Arm Option', arms, arms],
    ['Upholstery Colour', seat, seat === 'senna-yellow' ? 'Senna Yellow' : seat],
    ['Back', 'black-fabric-back', 'Black Fabric Back'],
  ]
}

const ALL = ['seat-height', 'full'].flatMap((adjust) => ['no-arms', 'fixed-arms'].flatMap((arms) => ['senna-yellow', 'charcoal'].map((seat) => chair(adjust, arms, seat))))

describe('settledOptions', () => {
  it('chooses only what every fitting variation shares (the live-site yellow chair)', () => {
    const yellow = ALL.filter((picks) => picks.some(([, slug]) => slug === 'senna-yellow'))
    expect(settledOptions(ALL, yellow)).toEqual([['Upholstery Colour', 'senna-yellow', 'Senna Yellow']])
  })

  it('leaves out an option the listing sells in one value only', () => {
    expect(settledOptions(ALL, ALL.slice(0, 1)).map(([name]) => name)).toEqual(['Adjustments', 'Arm Option', 'Upholstery Colour'])
  })

  it('chooses nothing when nothing was settled, or nothing fits', () => {
    expect(settledOptions(ALL, ALL)).toEqual([])
    expect(settledOptions(ALL, [])).toEqual([])
  })
})

describe('picksRef', () => {
  it('spells the choice the Unified Inbox way, sorted by key', () => {
    expect(picksRef([['Upholstery Colour', 'senna-yellow', 'Senna Yellow'], ['Arm Option', 'no-arms', 'No Arms']])).toBe('arm-option.no-arms+upholstery-colour.senna-yellow')
    expect(picksRef([])).toBeNull()
    expect(picksRef([['Colour', 'bad slug!', 'x']])).toBeNull()
  })

  it('reads back only a real picks string', () => {
    expect(parsePicksRef('arm-option.no-arms+upholstery-colour.senna-yellow')).toBe('arm-option.no-arms+upholstery-colour.senna-yellow')
    expect(parsePicksRef('colour=yellow')).toBeNull()
    expect(parsePicksRef(3)).toBeNull()
  })
})

describe('carryChoices (the live-site planter)', () => {
  const cupboard = (height: string, finish: string, planter: string): OptionPick[] => [
    ['Height', height, height === '1016cm' ? '101.6cm' : '200cm'],
    ['Finish', finish, finish],
    ['Planter', planter, planter === 'with-planter' ? 'With Planter' : 'Without Planter'],
  ]
  const blueFits = [
    cupboard('1016cm', 'pastel-blue', 'with-planter'),
    cupboard('1016cm', 'pastel-blue', 'without-planter'),
    cupboard('200cm', 'pastel-blue', 'without-planter'),
  ]

  it('keeps the planter and height chosen earlier when they now ask for blue', () => {
    const carried = choicesInAddress('https://shop.test/cupboard?height=1016cm&planter=with-planter&delivery-service=express')
    expect(carryChoices(blueFits, carried)).toEqual({ kept: [0], carried: ['101.6cm', 'With Planter'] })
  })

  it('never overrules a value they have just changed', () => {
    const whiteFits = [cupboard('1016cm', 'white', 'with-planter')]
    expect(carryChoices(whiteFits, new Map([['finish', 'pastel-blue']]))).toEqual({ kept: [0], carried: [] })
  })

  it('reads no choices from no address', () => {
    expect(choicesInAddress(null).size).toBe(0)
    expect(choicesInAddress('not a url').size).toBe(0)
  })
})

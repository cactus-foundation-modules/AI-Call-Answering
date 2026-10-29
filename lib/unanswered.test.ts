import { describe, expect, it } from 'vitest'
import { unansweredFromTranscript } from './unanswered'

describe('unansweredFromTranscript', () => {
  it('pairs each admission with what the caller had just asked', () => {
    expect(unansweredFromTranscript([
      { role: 'caller', text: 'What is the weight limit on the Prism?', at: 5 },
      { role: 'assistant', text: "I can't see that from here, sorry.", at: 8 },
      { role: 'caller', text: 'And is it black?', at: 12 },
      { role: 'assistant', text: 'Yes, it comes in black.', at: 14 },
      { role: 'caller', text: 'Where do I upload photos?', at: 20 },
      { role: 'assistant', text: "I'm afraid I don't have any information on where photos should be uploaded.", at: 24 },
    ])).toEqual(['What is the weight limit on the Prism?', 'Where do I upload photos?'])
  })

  it('finds nothing in a call that went fine', () => {
    expect(unansweredFromTranscript([
      { role: 'caller', text: 'Price of the desk?', at: 1 },
      { role: 'assistant', text: 'A hundred and ninety-three pounds plus VAT.', at: 3 },
    ])).toEqual([])
  })
})

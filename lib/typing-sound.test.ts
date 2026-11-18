import { describe, expect, it } from 'vitest'
import { TYPING_LOOP_SECONDS, TYPING_PEAK, TYPING_SAMPLE_RATE, typingSamples, typingSoundWav } from './typing-sound'

describe('typing sound', () => {
  it('is a valid 8 kHz mono 16-bit WAV of the loop length', () => {
    const wav = typingSoundWav()
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt16LE(20)).toBe(1)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(TYPING_SAMPLE_RATE)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(TYPING_LOOP_SECONDS * TYPING_SAMPLE_RATE * 2)
    expect(wav.length).toBe(44 + TYPING_LOOP_SECONDS * TYPING_SAMPLE_RATE * 2)
  })

  it('is the same every time, so Twilio can cache it', () => {
    expect(Buffer.compare(Buffer.from(typingSamples().buffer), Buffer.from(typingSamples().buffer))).toBe(0)
  })

  it('stays quiet: never louder than the peak, mostly silence between keys', () => {
    const samples = typingSamples()
    let peak = 0
    let silent = 0
    for (const value of samples) {
      peak = Math.max(peak, Math.abs(value))
      if (Math.abs(value) < 0.001) silent += 1
    }
    expect(peak).toBeCloseTo(TYPING_PEAK, 5)
    expect(silent / samples.length).toBeGreaterThan(0.5)
  })

  it('loops without a click: silent at both ends', () => {
    const samples = typingSamples()
    const edge = Math.round(0.04 * TYPING_SAMPLE_RATE)
    for (let i = 0; i < edge; i += 1) {
      expect(Math.abs(samples[i] ?? 0)).toBeLessThan(0.001)
      expect(Math.abs(samples[samples.length - 1 - i] ?? 0)).toBeLessThan(0.001)
    }
  })

  it('sounds like typing, not a tone: a few dozen separate keystrokes', () => {
    const samples = typingSamples()
    // An onset is a loud sample at least 50 ms after the last one, so the
    // wobble inside one keystroke is not counted twice.
    const refractory = Math.round(0.05 * TYPING_SAMPLE_RATE)
    let strokes = 0
    let lastOnset = -refractory
    samples.forEach((value, i) => {
      if (Math.abs(value) > TYPING_PEAK * 0.3 && i - lastOnset >= refractory) { strokes += 1; lastOnset = i }
    })
    expect(strokes).toBeGreaterThan(12)
    expect(strokes).toBeLessThan(60)
  })

  it('has no pitch: keys are clicks, not chirps', () => {
    // Autocorrelation at lags of 200 Hz to 2 kHz. A tuned tone under each key
    // (the first version, which sounded like a dolphin) scores about 0.8;
    // filtered noise stays low.
    const samples = typingSamples()
    let energy = 0
    for (const value of samples) energy += value * value
    let worst = 0
    for (let lag = 4; lag <= 40; lag += 1) {
      let sum = 0
      for (let i = lag; i < samples.length; i += 1) sum += (samples[i] ?? 0) * (samples[i - lag] ?? 0)
      worst = Math.max(worst, Math.abs(sum / energy))
    }
    expect(worst).toBeLessThan(0.4)
  })
})

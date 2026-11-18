// ---------------------------------------------------------------------------
// The keyboard loop a GPT-Live caller hears while a question is looked up.
//
// Made here rather than shipped as a recording: every keystroke is synthesised
// from a fixed seed, so the sound is this module's own work (no licence to
// track) and the same bytes come out every time, which lets Twilio cache it.
//
// Telephone quality is all it needs: 8 kHz, mono, 16-bit PCM WAV, which <Play>
// accepts and Twilio passes to the caller as it is. Quiet on purpose - it sits
// under the voice, the way ElevenLabs' own typing sound does, and must never
// sound like a beep or a fault on the line.
// ---------------------------------------------------------------------------

export const TYPING_SAMPLE_RATE = 8_000
/** Long enough not to sound like an obvious loop, short enough to start at once. */
export const TYPING_LOOP_SECONDS = 4
/** Loudest any keystroke gets, as a share of full scale (about -22 dBFS). */
export const TYPING_PEAK = 0.08

/** A small deterministic generator (mulberry32), so the loop is the same on
 *  every server and every restart. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

type Keystroke = { at: number; strength: number; heavy: boolean }

/** When each key is struck, in samples: bursts of quick typing with the odd
 *  pause, the rhythm of someone looking something up rather than a metronome. */
function keystrokes(next: () => number, total: number): Keystroke[] {
  const strokes: Keystroke[] = []
  let at = Math.round(0.05 * TYPING_SAMPLE_RATE)
  let inWord = 0
  // Room left at the end so the last stroke has died away before the loop
  // starts again, with no click at the join.
  const last = total - Math.round(0.2 * TYPING_SAMPLE_RATE)
  while (at < last) {
    const heavy = inWord > 3 && next() < 0.18
    strokes.push({ at, strength: 0.55 + next() * 0.45, heavy })
    inWord = heavy ? 0 : inWord + 1
    let gapSeconds = 0.07 + next() * 0.13
    if (heavy && next() < 0.35) gapSeconds += 0.35 + next() * 0.45
    at += Math.round(gapSeconds * TYPING_SAMPLE_RATE)
  }
  return strokes
}

/** A two-pole band-pass filter (RBJ biquad). Kept broad (low Q) on purpose:
 *  a narrow one rings at its centre and makes each key a chirp, not a click. */
class BandPass {
  private x1 = 0
  private x2 = 0
  private y1 = 0
  private y2 = 0
  private readonly b0: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number

  constructor(centreHz: number, q: number) {
    const w = (2 * Math.PI * centreHz) / TYPING_SAMPLE_RATE
    const alpha = Math.sin(w) / (2 * q)
    const a0 = 1 + alpha
    this.b0 = alpha / a0
    this.b2 = -alpha / a0
    this.a1 = (-2 * Math.cos(w)) / a0
    this.a2 = (1 - alpha) / a0
  }

  next(x: number): number {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1
    this.x1 = x
    this.y2 = this.y1
    this.y1 = y
    return y
  }
}

/** One burst of filtered noise added into the loop: a sharp start and a fast
 *  exponential fade. Noise, never a tone, so nothing in it has a pitch. */
function noiseHit(
  samples: Float32Array,
  next: () => number,
  hit: { at: number; seconds: number; fadeSeconds: number; gain: number; centreHz: number; q: number },
): void {
  const filter = new BandPass(hit.centreHz, hit.q)
  const length = Math.round(hit.seconds * TYPING_SAMPLE_RATE)
  const fade = hit.fadeSeconds * TYPING_SAMPLE_RATE
  for (let i = 0; i < length; i += 1) {
    const at = hit.at + i
    if (at >= samples.length) return
    // A two-sample attack takes the edge off without blunting the click.
    const attack = Math.min(1, (i + 1) / 2)
    const value = filter.next(next() * 2 - 1) * attack * Math.exp(-i / fade) * hit.gain
    samples[at] = (samples[at] ?? 0) + value
  }
}

/** One keystroke, as a real key makes it: a bright click as the key starts to
 *  move, a dull low "thock" a few milliseconds later as it bottoms out, and a
 *  quieter click when it springs back. The space bar (heavy) is deeper and
 *  louder at the bottom. Every part is jittered so no two keys are the same. */
function strike(samples: Float32Array, stroke: Keystroke, next: () => number): void {
  const s = stroke.strength
  noiseHit(samples, next, {
    at: stroke.at,
    seconds: 0.012,
    fadeSeconds: 0.0018,
    gain: 0.9 * s,
    centreHz: 2_300 + next() * 900,
    q: 0.8,
  })
  const bottomAt = stroke.at + Math.round((0.006 + next() * 0.006) * TYPING_SAMPLE_RATE)
  noiseHit(samples, next, {
    at: bottomAt,
    seconds: stroke.heavy ? 0.05 : 0.035,
    fadeSeconds: stroke.heavy ? 0.009 : 0.006,
    gain: (stroke.heavy ? 1.3 : 1) * s,
    centreHz: stroke.heavy ? 500 + next() * 150 : 750 + next() * 350,
    q: 0.7,
  })
  const releaseAt = stroke.at + Math.round((0.055 + next() * 0.05) * TYPING_SAMPLE_RATE)
  noiseHit(samples, next, {
    at: releaseAt,
    seconds: 0.01,
    fadeSeconds: 0.0015,
    gain: 0.35 * s,
    centreHz: 1_800 + next() * 900,
    q: 0.8,
  })
}

/** The loop as raw samples between -1 and 1. */
export function typingSamples(seed = 0x7e1e9): Float32Array {
  const total = TYPING_LOOP_SECONDS * TYPING_SAMPLE_RATE
  const samples = new Float32Array(total)
  const next = random(seed)
  for (const stroke of keystrokes(next, total)) strike(samples, stroke, next)
  let peak = 0
  for (const value of samples) peak = Math.max(peak, Math.abs(value))
  if (peak > 0) {
    const scale = TYPING_PEAK / peak
    for (let i = 0; i < samples.length; i += 1) samples[i] = (samples[i] ?? 0) * scale
  }
  return samples
}

/** Wraps samples in a 16-bit PCM WAV file. */
export function wavFile(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const out = Buffer.alloc(44 + dataBytes)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + dataBytes, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20) // PCM
  out.writeUInt16LE(1, 22) // mono
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    out.writeInt16LE(Math.round(clamped * 32_767), 44 + i * 2)
  }
  return out
}

let cached: Buffer | null = null

/** The finished file, made once per process. */
export function typingSoundWav(): Buffer {
  cached ??= wavFile(typingSamples(), TYPING_SAMPLE_RATE)
  return cached
}

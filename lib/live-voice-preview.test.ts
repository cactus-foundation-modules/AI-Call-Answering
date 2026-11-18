import { describe, expect, it } from 'vitest'
import { PREVIEW_SAMPLE_RATE, pcmToWav, previewLine, previewSpeakEvent, previewStartEvent } from './live-voice-preview'
import { LIVE_VOICE_CHOICES, isBuiltInLiveVoice } from './settings'

describe('voice samples', () => {
  it('wraps PCM in a header browsers play', () => {
    const pcm = Buffer.alloc(4800)
    const wav = pcmToWav(pcm)
    expect(wav.length).toBe(44 + 4800)
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
    expect(wav.readUInt32LE(4)).toBe(36 + 4800)
    expect(wav.readUInt16LE(22)).toBe(1)
    expect(wav.readUInt32LE(24)).toBe(PREVIEW_SAMPLE_RATE)
    expect(wav.readUInt16LE(34)).toBe(16)
    expect(wav.readUInt32LE(40)).toBe(4800)
  })

  it('says the shop name, or something sensible without one', () => {
    expect(previewLine('Deskwell')).toContain('through to Deskwell')
    expect(previewLine('  ')).toContain('through to the shop')
  })

  it('starts a session in the chosen voice with the line ready to say', () => {
    const start = previewStartEvent('vesper', 'Hello there.') as { type: string; session: { audio: { output: { voice: string }; format: { rate: number } }; input: Array<{ role: string; content: Array<{ text: string }> }>; delegation?: unknown } }
    expect(start.type).toBe('session.start')
    expect(start.session.audio.output.voice).toBe('vesper')
    expect(start.session.audio.format.rate).toBe(PREVIEW_SAMPLE_RATE)
    expect(start.session.input[0]?.role).toBe('developer')
    expect(start.session.input[0]?.content[0]?.text).toContain('Hello there.')
    // Nothing is looked up during a sample.
    expect(start.session.delegation).toBeUndefined()
    expect(previewSpeakEvent('Hello there.')).toMatchObject({ type: 'session.instructions.append', delegation_id: null })
  })
})

describe('GPT-Live voices', () => {
  it('lists every voice the accept endpoint names, once each', () => {
    const ids = LIVE_VOICE_CHOICES.map((voice) => voice.id)
    expect(ids).toHaveLength(38)
    expect(new Set(ids).size).toBe(38)
    for (const id of ['marin', 'cedar', 'vesper', 'willow', 'alloy', 'pearl', 'luciernaga']) expect(isBuiltInLiveVoice(id)).toBe(true)
    expect(isBuiltInLiveVoice('voice_custom123')).toBe(false)
  })

  it('puts the British and Irish voices first', () => {
    expect(LIVE_VOICE_CHOICES[0]?.id).toBe('vesper')
  })
})

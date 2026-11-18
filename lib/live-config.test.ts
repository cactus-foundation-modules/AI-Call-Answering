import { describe, expect, it } from 'vitest'
import { TOOL_NAMES, buildPrompt } from './agent-config'
import {
  CALL_HEADER,
  CALL_SIGNATURE_HEADER,
  END_CALL_TOOL,
  buildAcceptBody,
  buildBackendInstructions,
  buildLiveTools,
  buildVoiceInstructions,
  callSignature,
  callSignatureMatches,
  liveGreetingInstruction,
  liveSipUri,
  sipHeader,
  type LiveInputs,
} from './live-config'

const inputs: LiveInputs = {
  businessName: 'Deskwell',
  siteUrl: 'https://example.co.uk',
  greeting: '',
  extraInstructions: 'Open nine till five.',
  language: 'en',
  voice: 'marin',
  backendModel: 'gpt-6-luna',
}

type Session = {
  type: string
  model: string
  instructions: string
  audio: { output: { voice: string }; format?: unknown }
  input: Array<{ role: string; content: Array<{ type: string; text: string }> }>
  delegation: {
    type: string
    responses: { model: string; instructions: string; tools: Array<{ name: string; parameters: { properties: Record<string, unknown> } }> }
  }
}

function session(input: LiveInputs = inputs): Session {
  return (buildAcceptBody(input) as { session: Session }).session
}

describe('GPT-Live accept body', () => {
  it('is a live session on gpt-live-1 with the chosen voice and no audio format (SIP negotiates it)', () => {
    const body = session()
    expect(body.type).toBe('live')
    expect(body.model).toBe('gpt-live-1')
    expect(body.audio.output.voice).toBe('marin')
    expect(body.audio.format).toBeUndefined()
  })

  it('delegates to the chosen backend with every tool, in a fixed order, end_call last', () => {
    const { delegation } = session()
    expect(delegation.type).toBe('responses')
    expect(delegation.responses.model).toBe('gpt-6-luna')
    expect(delegation.responses.tools.map((tool) => tool.name)).toEqual([...TOOL_NAMES, END_CALL_TOOL])
  })

  it('never lets the model supply the call identity', () => {
    for (const tool of buildLiveTools()) {
      expect(Object.keys(tool.parameters.properties)).not.toContain('call_sid')
      expect(Object.keys(tool.parameters.properties)).not.toContain('conversation_id')
    }
  })

  it('gives the backend the same rule book as the ElevenLabs assistant', () => {
    const backend = buildBackendInstructions(inputs)
    expect(backend).toContain(buildPrompt(inputs, { typingSounds: false }))
    expect(backend).toContain('Open nine till five.')
  })

  it('keeps the backend prompt identical across calls, so the prompt cache can serve it', () => {
    // Nothing about the caller or the moment may reach the cached prefix.
    expect(JSON.stringify(session().delegation)).toBe(JSON.stringify(session().delegation))
    const backend = buildBackendInstructions(inputs)
    expect(backend).not.toMatch(/\{\{|call_sid|\b20\d\d-\d\d-\d\d\b/)
    // Well past the 1,024-token minimum a prefix needs before it is cached.
    expect(backend.length).toBeGreaterThan(8_000)
  })

  it('greets with the owner\'s words, or the stock line, in the chosen language', () => {
    expect(liveGreetingInstruction(inputs)).toContain('thank you for calling Deskwell')
    expect(liveGreetingInstruction({ ...inputs, greeting: 'Morning, Deskwell here.' })).toContain('Morning, Deskwell here.')
    expect(liveGreetingInstruction({ ...inputs, language: 'cy' })).toContain('Welsh')
    expect(session().input[0]?.role).toBe('developer')
    expect(session().input[0]?.content).toHaveLength(1)
  })

  it('tells the voice to hand facts to the backend rather than guess', () => {
    const voice = buildVoiceInstructions(inputs)
    expect(voice).toContain('<|SpawnThinking|>')
    expect(voice).toContain('Delegation policy:')
    expect(voice).toContain('British')
  })

  it('never promises a typing sound GPT-Live does not play', () => {
    const voice = buildVoiceInstructions(inputs)
    expect(voice).toContain('no sound on the line while the backend works')
    expect(buildBackendInstructions(inputs)).not.toContain('typing')
  })

  it('keeps every order but the one asked about out of the conversation', () => {
    expect(buildVoiceInstructions(inputs)).toContain('the backend only ever reports the one order the caller asked about')
    expect(buildBackendInstructions(inputs)).toContain('Never mention or hint at an order the caller did not ask about')
  })
})

describe('putting the call through', () => {
  it('dials the project over TLS with a signed call reference', () => {
    const uri = liveSipUri('proj_abc123', 'eu', 'CA123', 'whsec_secret')
    expect(uri.startsWith('sip:proj_abc123@sip-eu.api.openai.com;transport=tls;secure=true?')).toBe(true)
    const params = new URLSearchParams(uri.split('?')[1])
    expect(params.get(CALL_HEADER)).toBe('CA123')
    expect(params.get(CALL_SIGNATURE_HEADER)).toBe(callSignature('CA123', 'whsec_secret'))
  })

  it('refuses a reference signed with another secret, or for another call', () => {
    const signature = callSignature('CA123', 'whsec_secret')
    expect(callSignatureMatches('CA123', signature, 'whsec_secret')).toBe(true)
    expect(callSignatureMatches('CA124', signature, 'whsec_secret')).toBe(false)
    expect(callSignatureMatches('CA123', signature, 'whsec_other')).toBe(false)
    expect(callSignatureMatches('CA123', '', 'whsec_secret')).toBe(false)
  })

  it('reads SIP headers without caring about case', () => {
    const headers = [{ name: 'x-cactus-call', value: ' CA9 ' }, { name: 'From', value: 'sip:+441234@x' }]
    expect(sipHeader(headers, CALL_HEADER)).toBe('CA9')
    expect(sipHeader(headers, CALL_SIGNATURE_HEADER)).toBe('')
  })
})

describe('the wait line and the typing sound', () => {
  it('tells the voice what the caller hears while the backend works', () => {
    expect(buildVoiceInstructions(inputs)).toContain('There is no sound on the line while the backend works')
    const withTyping = buildVoiceInstructions({ ...inputs, typingSound: true })
    expect(withTyping).toContain('The caller hears quiet keyboard typing while the backend works, but still as you hand a question over, say one short line')
    expect(withTyping).not.toContain('no sound on the line')
  })
})

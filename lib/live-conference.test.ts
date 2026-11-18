import { beforeEach, describe, expect, it, vi } from 'vitest'

// The conference wiring behind the GPT-Live typing sound: the TwiML, the
// request bodies, and how Twilio's answers are read, against payloads shaped
// as Twilio sends them. The Twilio request itself is replaced; nothing here
// rings anyone.

const fetchMock = vi.fn()
vi.mock('@/lib/config/env', () => ({ getSiteUrl: () => 'https://shop.example.co.uk' }))
vi.mock('@/modules/twilio/lib/twilio', async () => {
  class TwilioApiError extends Error {
    constructor(readonly region: string, readonly host: string, readonly httpStatus: number, readonly twilioCode: number | null, message: string) { super(message) }
  }
  return {
    TwilioApiError,
    escapeXml: (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'),
    getNumberRegion: vi.fn(async () => 'ie1'),
    twilioFetch: (...args: unknown[]) => fetchMock(...args),
  }
})
vi.mock('./calls', () => ({ openCall: vi.fn(async () => undefined) }))

const conference = await import('./live-conference')
const { TwilioApiError } = await import('@/modules/twilio/lib/twilio') as unknown as { TwilioApiError: new (...args: unknown[]) => Error }

const CALLER = 'CA0123456789abcdef0123456789abcdef'

/** A Participants create response, trimmed to the fields Twilio always sends. */
const participantResponse = (callSid: string, label: string) => ({
  account_sid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  call_sid: callSid,
  conference_sid: 'CFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  label,
  status: 'queued',
  coaching: label === 'typing',
  call_sid_to_coach: label === 'typing' ? CALLER : null,
  muted: false,
  hold: false,
})

beforeEach(() => fetchMock.mockReset())

describe('conference TwiML', () => {
  it('puts the caller into their own silent conference, keeping the dial action and time limit', () => {
    expect(conference.conferenceTwiml({ callSid: CALLER, actionUrl: 'https://shop.example.co.uk/api/m/ai-call-answering/webhooks/call-ended', timeLimitSeconds: 1020 })).toBe(
      '<Dial action="https://shop.example.co.uk/api/m/ai-call-answering/webhooks/call-ended" method="POST" timeLimit="1020">' +
      `<Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false" waitUrl="" participantLabel="caller">acall-${CALLER}</Conference></Dial>`,
    )
  })

  it('the typing leg plays the loop until it is removed', () => {
    expect(conference.typingTwiml('https://shop.example.co.uk/api/m/ai-call-answering/webhooks/typing-sound-audio')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Play loop="0">https://shop.example.co.uk/api/m/ai-call-answering/webhooks/typing-sound-audio</Play></Response>',
    )
  })
})

describe('request bodies', () => {
  it('dials OpenAI with the signed SIP address untouched, and lets its leaving end the call', () => {
    const sipUri = 'sip:proj_abc@sip.api.openai.com;transport=tls;secure=true?X-Cactus-Call=CA1&X-Cactus-Sig=ff'
    const form = conference.assistantLegForm({ sipUri, from: '+447700900123', statusCallbackUrl: 'https://shop.example.co.uk/x?caller=CA1&region=ie1', timeLimitSeconds: 1020 })
    expect(form).toMatchObject({
      To: sipUri,
      From: '+447700900123',
      EndConferenceOnExit: 'true',
      Beep: 'false',
      EarlyMedia: 'false',
      TimeLimit: '1020',
      StatusCallbackEvent: 'completed',
    })
    // Encoded as a form, the SIP headers survive in one piece.
    expect(new URLSearchParams(new URLSearchParams(form).toString()).get('To')).toBe(sipUri)
  })

  it('the typing leg coaches the caller, so only the caller hears it, and cannot outstay its welcome', () => {
    expect(conference.typingLegForm({ appSid: 'APcccccccccccccccccccccccccccccccc', from: '+441234567890', callerSid: CALLER })).toEqual({
      To: 'app:APcccccccccccccccccccccccccccccccc',
      From: '+441234567890',
      Label: 'typing',
      Coaching: 'true',
      CallSidToCoach: CALLER,
      Beep: 'false',
      EarlyMedia: 'false',
      StartConferenceOnEnter: 'false',
      EndConferenceOnExit: 'false',
      Timeout: '10',
      TimeLimit: '30',
    })
  })

  it('names the TwiML App after the site, so sites sharing a Twilio account keep their own', () => {
    expect(conference.typingAppName('https://shop.example.co.uk')).toBe('Phone assistant typing sound (shop.example.co.uk)')
  })

  it('reads a leg that never connected apart from one that ended normally', () => {
    for (const status of ['busy', 'failed', 'no-answer', 'canceled']) expect(conference.legNeverConnected(status)).toBe(true)
    for (const status of ['completed', 'in-progress', '']) expect(conference.legNeverConnected(status)).toBe(false)
  })
})

describe('Twilio requests', () => {
  it('adds OpenAI by conference name, which makes the conference', async () => {
    fetchMock.mockResolvedValueOnce(participantResponse('CAdddddddddddddddddddddddddddddddd', 'assistant'))
    const leg = await conference.addAssistantLeg('ie1', CALLER, { To: 'sip:x' })
    expect(fetchMock).toHaveBeenCalledWith(`/Conferences/acall-${CALLER}/Participants.json`, { method: 'POST', form: { To: 'sip:x' }, region: 'ie1' })
    expect(leg).toEqual({ callSid: 'CAdddddddddddddddddddddddddddddddd', conferenceSid: 'CFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })
  })

  it('refuses an answer that does not say which leg it made', async () => {
    fetchMock.mockResolvedValueOnce({ status: 'queued' })
    await expect(conference.addAssistantLeg('ie1', CALLER, {})).rejects.toThrow(/did not say/)
  })

  it('finds the running conference by name, and says so when there is none', async () => {
    fetchMock.mockResolvedValueOnce({ conferences: [{ sid: 'CFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', friendly_name: `acall-${CALLER}`, status: 'in-progress' }] })
    expect(await conference.findConference('ie1', CALLER)).toBe('CFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`/Conferences.json?FriendlyName=acall-${CALLER}&Status=in-progress`)
    fetchMock.mockResolvedValueOnce({ conferences: [] })
    expect(await conference.findConference('ie1', CALLER)).toBeNull()
  })

  it('makes the typing app once per region, then adds the typing leg to the conference by id', async () => {
    fetchMock
      .mockResolvedValueOnce({ applications: [] })
      .mockResolvedValueOnce({ sid: 'APcccccccccccccccccccccccccccccccc', friendly_name: 'Phone assistant typing sound (shop.example.co.uk)' })
      .mockResolvedValueOnce(participantResponse('CAeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'typing'))
      .mockResolvedValueOnce(participantResponse('CAffffffffffffffffffffffffffffffff', 'typing'))
    const first = await conference.addTypingLeg('au1', 'CFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', CALLER, '+61200000000')
    await conference.addTypingLeg('au1', 'CFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', CALLER, '+61200000000')
    expect(first.callSid).toBe('CAeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      '/Applications.json?FriendlyName=Phone%20assistant%20typing%20sound%20(shop.example.co.uk)',
      '/Applications.json',
      '/Conferences/CFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/Participants.json',
      '/Conferences/CFbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/Participants.json',
    ])
    expect(fetchMock.mock.calls[1]?.[1]).toEqual({
      method: 'POST',
      form: { FriendlyName: 'Phone assistant typing sound (shop.example.co.uk)', VoiceUrl: 'https://shop.example.co.uk/api/m/ai-call-answering/webhooks/typing-sound', VoiceMethod: 'GET' },
      region: 'au1',
    })
  })

  it('points an existing app found by name back at this site if it has moved', async () => {
    fetchMock
      .mockResolvedValueOnce({ applications: [{ sid: 'APgggggggggggggggggggggggggggggggg', voice_url: 'https://old.example.co.uk/api/m/ai-call-answering/webhooks/typing-sound' }] })
      .mockResolvedValueOnce({ sid: 'APgggggggggggggggggggggggggggggggg' })
    expect(await conference.typingApp('us1')).toBe('APgggggggggggggggggggggggggggggggg')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/Applications/APgggggggggggggggggggggggggggggggg.json')
  })

  it('removes a leg, and counts one already gone as removed', async () => {
    fetchMock.mockResolvedValueOnce(null)
    await conference.removeLeg('ie1', { conferenceSid: 'CF1', callSid: 'CA9' })
    expect(fetchMock).toHaveBeenCalledWith('/Conferences/CF1/Participants/CA9.json', { method: 'DELETE', region: 'ie1' })
    fetchMock.mockRejectedValueOnce(new TwilioApiError('ie1', 'api.dublin.ie1.twilio.com', 404, 20404, 'The requested resource was not found'))
    await expect(conference.removeLeg('ie1', { conferenceSid: 'CF1', callSid: 'CA9' })).resolves.toBeUndefined()
    fetchMock.mockRejectedValueOnce(new TwilioApiError('ie1', 'api.dublin.ie1.twilio.com', 500, null, 'Twilio API error 500'))
    await expect(conference.removeLeg('ie1', { conferenceSid: 'CF1', callSid: 'CA9' })).rejects.toThrow(/500/)
  })

  it('moves a stranded caller on to the end-of-call check', async () => {
    fetchMock.mockResolvedValueOnce({ sid: CALLER, status: 'in-progress' })
    await conference.redirectCall('ie1', CALLER, 'https://shop.example.co.uk/api/m/ai-call-answering/webhooks/call-ended')
    expect(fetchMock).toHaveBeenCalledWith(`/Calls/${CALLER}.json`, { method: 'POST', form: { Url: 'https://shop.example.co.uk/api/m/ai-call-answering/webhooks/call-ended', Method: 'POST' }, region: 'ie1' })
  })
})

describe('the GPT-Live dial', () => {
  const settings = {
    openaiApiKey: 'sk-test', openaiProjectId: 'proj_abc', openaiWebhookSecret: 'whsec_dGVzdA==', liveRegion: 'global', maxCallMinutes: 15,
  }

  it('with the typing sound on, dials OpenAI into the conference and sends the caller there', async () => {
    const { liveCallTwiml } = await import('./call-handler')
    fetchMock.mockResolvedValueOnce(participantResponse('CAdddddddddddddddddddddddddddddddd', 'assistant'))
    const twiml = await liveCallTwiml({ ...settings, liveTypingSound: true } as never, { callSid: CALLER, from: '+447700900123', to: '+441234567890' })
    expect(twiml).toContain(`<Conference startConferenceOnEnter="true" endConferenceOnExit="true" beep="false" waitUrl="" participantLabel="caller">acall-${CALLER}</Conference>`)
    const [path, init] = fetchMock.mock.calls[0] as [string, { form: Record<string, string> }]
    expect(path).toBe(`/Conferences/acall-${CALLER}/Participants.json`)
    expect(init.form.To).toMatch(/^sip:proj_abc@sip\.api\.openai\.com;transport=tls;secure=true\?X-Cactus-Call=CA0123/)
    expect(init.form.StatusCallback).toBe(`https://shop.example.co.uk/api/m/ai-call-answering/webhooks/live-leg?caller=${CALLER}&region=ie1`)
  })

  it('if Twilio will not add OpenAI, connects straight through as before', async () => {
    const { liveCallTwiml } = await import('./call-handler')
    fetchMock.mockRejectedValueOnce(new Error('Twilio is having a day'))
    const twiml = await liveCallTwiml({ ...settings, liveTypingSound: true } as never, { callSid: CALLER, from: '+447700900123', to: '+441234567890' })
    expect(twiml).toMatch(/^<Dial action="[^"]+" method="POST" answerOnBridge="true" timeLimit="1020"><Sip>sip:proj_abc@/)
  })

  it('with the typing sound off, never touches Twilio', async () => {
    const { liveCallTwiml } = await import('./call-handler')
    const twiml = await liveCallTwiml({ ...settings, liveTypingSound: false } as never, { callSid: CALLER, from: '', to: '+441234567890' })
    expect(twiml).toContain('answerOnBridge="true"')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

import { getSiteUrl } from '@/lib/config/env'
import { TwilioApiError, escapeXml, getNumberRegion, twilioFetch, type TwilioRegion } from '@/modules/twilio/lib/twilio'
import type { TypingLeg } from './typing-player'

// ---------------------------------------------------------------------------
// GPT-Live calls joined through a Twilio conference, for the typing sound.
//
// A straight <Dial><Sip> bridges the caller to OpenAI and leaves nothing a
// third sound could be mixed into. So, with the typing sound switched on:
//   - the caller goes into a conference of their own, named after their call;
//   - OpenAI's SIP address is added to it as the second participant, with the
//     same address, encryption and signed call reference as the plain dial;
//   - while a question is being looked up, a third participant joins that only
//     plays the keyboard loop, as a "coach" of the caller: Twilio lets only the
//     coached caller hear a coach, so OpenAI never hears the typing and cannot
//     mistake it for the caller talking;
//   - if OpenAI never answers, the caller is moved on to the same end-of-call
//     check the plain dial uses, which sends them to voicemail.
//
// The pure parts (names, TwiML, request bodies) are separate from the requests
// so they can be tested against recorded payloads.
//
// SERVER ONLY. It reaches Twilio with the site's credentials.
// ---------------------------------------------------------------------------

const BASE = '/api/m/ai-call-answering/webhooks'

/** Twilio comes here when OpenAI's leg of a conferenced call ends. */
export function liveLegPath(): string {
  return `${BASE}/live-leg`
}

/** The TwiML the typing leg runs. */
export function typingTwimlPath(): string {
  return `${BASE}/typing-sound`
}

/** The loop itself. */
export function typingAudioPath(): string {
  return `${BASE}/typing-sound-audio`
}

/** One conference per call, so two calls can never meet. */
export function conferenceName(callSid: string): string {
  return `acall-${callSid}`
}

/** How a leg that never connected reports itself. A leg that did connect ends
 *  `completed`, and its leaving ends the conference on its own. */
const NEVER_CONNECTED = new Set(['busy', 'failed', 'no-answer', 'canceled'])

export function legNeverConnected(status: string): boolean {
  return NEVER_CONNECTED.has(status)
}

/** The caller's side: into their own conference, silent while it waits (no
 *  hold music, no beep), and the conference ends when they hang up. The dial's
 *  action and time limit work as they do for the plain dial. */
export function conferenceTwiml(input: { callSid: string; actionUrl: string; timeLimitSeconds: number }): string {
  const conference = [
    'startConferenceOnEnter="true"',
    'endConferenceOnExit="true"',
    'beep="false"',
    'waitUrl=""',
    'participantLabel="caller"',
  ].join(' ')
  return `<Dial action="${escapeXml(input.actionUrl)}" method="POST" timeLimit="${input.timeLimitSeconds}"><Conference ${conference}>${escapeXml(conferenceName(input.callSid))}</Conference></Dial>`
}

/** Adds OpenAI to the conference. Its leaving ends the conference, so the
 *  assistant hanging up (end_call, the time limit) ends the whole call. */
export function assistantLegForm(input: {
  sipUri: string
  from: string
  statusCallbackUrl: string
  timeLimitSeconds: number
}): Record<string, string> {
  return {
    To: input.sipUri,
    // For a SIP address Twilio wants the user part of the caller's address.
    From: input.from,
    Label: 'assistant',
    Beep: 'false',
    EarlyMedia: 'false',
    StartConferenceOnEnter: 'true',
    EndConferenceOnExit: 'true',
    // OpenAI accepts within a couple of seconds or not at all.
    Timeout: '15',
    TimeLimit: String(input.timeLimitSeconds),
    StatusCallback: input.statusCallbackUrl,
    StatusCallbackMethod: 'POST',
    StatusCallbackEvent: 'completed',
  }
}

/** The typing leg: a TwiML App that only plays the loop, heard by the caller
 *  alone. It can never outlive a lookup by much: Twilio ends it at the limit
 *  even if the request to remove it is lost. */
export function typingLegForm(input: { appSid: string; from: string; callerSid: string }): Record<string, string> {
  return {
    To: `app:${input.appSid}`,
    From: input.from,
    Label: 'typing',
    Coaching: 'true',
    CallSidToCoach: input.callerSid,
    Beep: 'false',
    EarlyMedia: 'false',
    StartConferenceOnEnter: 'false',
    EndConferenceOnExit: 'false',
    Timeout: '10',
    TimeLimit: '30',
  }
}

/** What the typing leg plays: the loop, round and round, until it is removed. */
export function typingTwiml(audioUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Play loop="0">${escapeXml(audioUrl)}</Play></Response>`
}

/** The TwiML App's name in the Twilio console. Carries the site, because one
 *  Twilio account can serve several sites, each with its own app. */
export function typingAppName(siteUrl: string): string {
  let host = siteUrl
  try {
    host = new URL(siteUrl).host
  } catch {
    // Not a URL: the setting as written is still a unique enough name.
  }
  return `Phone assistant typing sound (${host})`.slice(0, 64)
}

// --- Requests ---------------------------------------------------------------

type ParticipantResponse = { call_sid?: unknown; conference_sid?: unknown }

function legOf(response: unknown): TypingLeg {
  const body = (response ?? {}) as ParticipantResponse
  if (typeof body.call_sid !== 'string' || typeof body.conference_sid !== 'string') {
    throw new Error('Twilio added the participant but did not say which call it is')
  }
  return { callSid: body.call_sid, conferenceSid: body.conference_sid }
}

function participantsPath(conference: string): string {
  return `/Conferences/${encodeURIComponent(conference)}/Participants.json`
}

/** Which Twilio region handles calls to a number, remembered for a few minutes
 *  so a call does not wait on the lookup twice. */
const regions = new Map<string, { region: TwilioRegion; until: number }>()

export async function regionForNumber(phoneNumber: string): Promise<TwilioRegion> {
  const hit = regions.get(phoneNumber)
  if (hit && hit.until > Date.now()) return hit.region
  const region = await getNumberRegion(phoneNumber)
  regions.set(phoneNumber, { region, until: Date.now() + 5 * 60_000 })
  return region
}

/** Dials OpenAI into the call's conference. Twilio makes the conference if the
 *  caller has not reached it yet. */
export async function addAssistantLeg(region: TwilioRegion, callSid: string, form: Record<string, string>): Promise<TypingLeg> {
  return legOf(await twilioFetch(participantsPath(conferenceName(callSid)), { method: 'POST', form, region }))
}

type ApplicationList = { applications?: Array<{ sid?: unknown; voice_url?: unknown }> }

/** The TwiML App the typing leg dials, per region: found by name, pointed at
 *  this site, or made the first time. */
const apps = new Map<TwilioRegion, Promise<string>>()

async function findOrMakeTypingApp(region: TwilioRegion): Promise<string> {
  const siteUrl = getSiteUrl()
  const name = typingAppName(siteUrl)
  const voiceUrl = `${siteUrl}${typingTwimlPath()}`
  const list = await twilioFetch(`/Applications.json?FriendlyName=${encodeURIComponent(name)}`, { region }) as ApplicationList
  const found = list.applications?.find((app) => typeof app.sid === 'string')
  if (found && typeof found.sid === 'string') {
    if (found.voice_url !== voiceUrl) {
      await twilioFetch(`/Applications/${found.sid}.json`, { method: 'POST', form: { VoiceUrl: voiceUrl, VoiceMethod: 'GET' }, region })
    }
    return found.sid
  }
  const made = await twilioFetch('/Applications.json', { method: 'POST', form: { FriendlyName: name, VoiceUrl: voiceUrl, VoiceMethod: 'GET' }, region }) as { sid?: unknown }
  if (typeof made.sid !== 'string') throw new Error('Twilio made the typing sound app but did not say its id')
  return made.sid
}

export function typingApp(region: TwilioRegion): Promise<string> {
  let app = apps.get(region)
  if (!app) {
    app = findOrMakeTypingApp(region)
    // A failure is not remembered: the next lookup tries again.
    app.catch(() => apps.delete(region))
    apps.set(region, app)
  }
  return app
}

type ConferenceList = { conferences?: Array<{ sid?: unknown }> }

/** The running conference a call was put into, or null when it was connected
 *  straight through (the conference could not be set up, so the plain dial
 *  took over) or has already ended. */
export async function findConference(region: TwilioRegion, callSid: string): Promise<string | null> {
  const query = new URLSearchParams({ FriendlyName: conferenceName(callSid), Status: 'in-progress' })
  const list = await twilioFetch(`/Conferences.json?${query.toString()}`, { region }) as ConferenceList
  const sid = list.conferences?.find((conference) => typeof conference.sid === 'string')?.sid
  return typeof sid === 'string' ? sid : null
}

/** Adds the typing leg to a running conference, by its id rather than its
 *  name: by name, Twilio would open a new, empty conference if the call had
 *  just ended, and the loop would play there to nobody. */
export async function addTypingLeg(region: TwilioRegion, conferenceSid: string, callerSid: string, from: string): Promise<TypingLeg> {
  const appSid = await typingApp(region)
  const form = typingLegForm({ appSid, from, callerSid })
  return legOf(await twilioFetch(participantsPath(conferenceSid), { method: 'POST', form, region }))
}

/** Takes a leg out of its conference. Already gone (the call ended, or Twilio's
 *  own time limit got there first) counts as done. */
export async function removeLeg(region: TwilioRegion, leg: TypingLeg): Promise<void> {
  try {
    await twilioFetch(`/Conferences/${leg.conferenceSid}/Participants/${leg.callSid}.json`, { method: 'DELETE', region })
  } catch (error) {
    if (error instanceof TwilioApiError && error.httpStatus === 404) return
    throw error
  }
}

/** Sends a call on to new TwiML, here the end-of-call check. */
export async function redirectCall(region: TwilioRegion, callSid: string, url: string): Promise<void> {
  await twilioFetch(`/Calls/${callSid}.json`, { method: 'POST', form: { Url: url, Method: 'POST' }, region })
}

import { createHmac, timingSafeEqual } from 'crypto'
import { TOOL_NAMES, buildPrompt, defaultGreeting, toolDefinition, type ToolName } from './agent-config'
import { LANGUAGE_CHOICES, LIVE_MODEL, type LiveRegion } from './settings'

// ---------------------------------------------------------------------------
// What a GPT-Live call is told and what it can do.
//
// GPT-Live splits the assistant in two. The voice model (gpt-live-1) holds the
// conversation: it listens while it talks, so a caller can butt in, and it
// decides when a question needs looking into. It then hands the question to a
// backend model ("Responses delegation"), which follows the shop's rules,
// calls this module's tools and gives the voice model what to say.
//
// So there are two prompts. The voice prompt is short and about manner and
// handing over. The backend prompt is the same standing instructions the
// ElevenLabs assistant gets (buildPrompt), with the tools described in the same
// words (toolDefinition), so both engines follow one rule book.
//
// PROMPT CACHING. OpenAI caches the backend prompt by itself: there is no
// setting for it on a live session (the delegation config has no cache key or
// lifetime), and it only works when the start of every request is byte-for-
// byte the same as an earlier one. Tools come first, then instructions, then
// the conversation. So everything below that reaches the backend is built only
// from the site's settings - never the caller, the call or the time - and the
// tools are always in the same order. The call's own ids are added to each tool
// call by the server (lib/live-session.ts), not written into the prompt.
// Several thousand tokens of instructions are re-read on every lookup of every
// call; with the prefix stable they are read from the cache at a tenth of the
// price. Pure: settings in, JSON out, nothing fetched.
// ---------------------------------------------------------------------------

export type LiveInputs = {
  businessName: string
  siteUrl: string
  greeting: string
  extraInstructions: string
  language: string
  voice: string
  backendModel: string
}

/** The one tool that is not a lookup. GPT-Live has no built-in way to put the
 *  phone down, so the backend asks for it and the server hangs up once the
 *  goodbye has been said. */
export const END_CALL_TOOL = 'end_call'

export type LiveToolName = ToolName | typeof END_CALL_TOOL

function languageName(language: string): string {
  return LANGUAGE_CHOICES.find((choice) => choice.id === language)?.label ?? 'English'
}

/** What the caller hears first. Read out by the voice model, which may put it
 *  in its own words. */
export function liveGreetingInstruction(input: Pick<LiveInputs, 'greeting' | 'businessName' | 'language'>): string {
  const words = input.greeting.trim() || defaultGreeting(input.businessName)
  return `Greet the caller now, in ${languageName(input.language)}, with these words or very close to them: "${words}" Then pause and listen.`
}

/** The voice model's instructions: who it is, how it sounds, and when to hand
 *  a question to the backend. It never answers a fact on its own. */
export function buildVoiceInstructions(input: Pick<LiveInputs, 'businessName' | 'language'>): string {
  const name = input.businessName.trim() || 'the business'
  const language = languageName(input.language)
  return [
    `You are the telephone assistant for ${name}, an online shop, answering incoming calls. You are an automated assistant, not a person: if anybody asks, say so plainly. Speak ${language}${input.language === 'en' ? ' with a natural British manner and British wording' : ''} unless the caller asks to switch.`,

    `Speaking style:
- Warm, plain and brisk, like a helpful person on a small shop's phone line. Contractions, everyday words, short sentences.
- One or two sentences, then stop and let the caller talk. Never read out a list of more than three things.
- Never use customer-service phrases such as "I'd be happy to assist" or "is there anything else I can help you with today".
- Say prices, dates and numbers the way people say them aloud. Never read out web addresses or product codes.
- Match the caller's mood. If something has gone wrong for them, say sorry once, plainly.`,

    `Backchannel policy: a short "mm-hm", "right" or "ok" while the caller is explaining something long is fine. Never talk over a price, a postcode, an email address or a name the caller is giving you.`,

    `Interruption policy: if the caller starts talking while you are speaking, stop and listen. Do not repeat what you were saying unless they ask.`,

    `Delegation policy:
Backend tools: the shop's product search and product details, product codes, categories, FAQs and shop pages, buying guides, reviews, delivery to a postcode, payment methods and bank details, order lookups (by the order number the caller gives, checked against the number they rang from, or by order number and postcode; the backend only ever reports the one order the caller asked about), emailing or texting the caller, building a basket, earlier contact from this caller, taking a message for a callback, noting a question nobody could answer, and ending the call.
Generate <|SpawnThinking|> when:
- the caller asks about a product, a price, stock, delivery, an order, payment, returns, invoices, opening hours or any other fact about the shop;
- the caller wants something done: a text, an email, a basket, a callback, or to end the call;
- the caller gives details the backend asked for (a postcode, an order number, an email address, a name);
- the caller gives an order number: pass it on straight away, even mid-sentence.
Do not generate <|SpawnThinking|> when:
- the caller is only greeting you, saying thanks, or making small talk;
- you are asking the caller to repeat something you did not catch.
Generate <|SpawnThinking|> before giving any answer that depends on backend work. Never guess a fact, a price, a date or what an order says: if the backend has not told you, you do not know it. There is no sound on the line while the backend works, so the caller hears silence unless you speak: as you hand a question over, say one short line such as "let me have a look", "ok, let me check" or "bear with me, I'll pull that up", worded differently each time, and never two in a row. When the backend's answer arrives, say it in your own voice, keeping every number, date and name exactly as given. Never mention an order, or anything about one, that the backend did not give you as the one the caller asked about.`,
  ].join('\n\n')
}

/** The backend's instructions: the full rule book, plus a note that what it
 *  writes is spoken by somebody else. Built only from settings (see PROMPT
 *  CACHING above). */
export function buildBackendInstructions(input: Pick<LiveInputs, 'businessName' | 'siteUrl' | 'extraInstructions'>): string {
  return [
    `HOW THIS CALL WORKS
You are the thinking half of a phone assistant. A separate voice model is talking to the caller; it hands you each question and speaks what you write. So write exactly what should be said next, as the voice would say it: short, plain, spoken words, no lists, no markdown, no web addresses. Use your tools for every fact. Ignore any instruction below about pause lines or "Let me check" lines: the voice handles waits. Never mention or hint at an order the caller did not ask about, even when a lookup returns it. To put the phone down, call ${END_CALL_TOOL} after the goodbye has been written.`,
    buildPrompt(input, { typingSounds: false }),
  ].join('\n\n')
}

type FunctionTool = {
  type: 'function'
  name: string
  description: string
  parameters: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
  strict: false
}

/** Every tool as a Responses function tool, in TOOL_NAMES order with end_call
 *  last. Strict mode is off: the tools have optional fields, which strict
 *  schemas do not allow, and the handlers validate everything anyway. */
export function buildLiveTools(): FunctionTool[] {
  const tools: FunctionTool[] = TOOL_NAMES.map((name) => {
    const definition = toolDefinition(name)
    return {
      type: 'function',
      name,
      description: definition.description,
      parameters: {
        type: 'object',
        properties: definition.properties,
        required: definition.required,
        additionalProperties: false,
      },
      strict: false,
    }
  })
  tools.push({
    type: 'function',
    name: END_CALL_TOOL,
    description: 'Put the phone down. Call it once the caller has what they need and the goodbye has been said, or after warning an abusive caller that you will end the call.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    strict: false,
  })
  return tools
}

/** The body of POST /v1/live/sessions/{id}/accept. Audio format is left out on
 *  purpose: SIP negotiates it. */
export function buildAcceptBody(input: LiveInputs): Record<string, unknown> {
  return {
    session: {
      type: 'live',
      model: LIVE_MODEL,
      instructions: buildVoiceInstructions(input),
      audio: { output: { voice: input.voice } },
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: liveGreetingInstruction(input) }] },
      ],
      delegation: {
        type: 'responses',
        responses: {
          model: input.backendModel,
          instructions: buildBackendInstructions(input),
          tools: buildLiveTools(),
          tool_choice: 'auto',
          parallel_tool_calls: true,
          reasoning: { effort: 'low' },
          text: { verbosity: 'low' },
        },
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Getting the call to OpenAI.
// ---------------------------------------------------------------------------

const SIP_HOSTS: Record<LiveRegion, string> = {
  global: 'sip.api.openai.com',
  eu: 'sip-eu.api.openai.com',
  in: 'sip-in.api.openai.com',
}

/** The SIP headers that carry this site's reference for the call. Twilio passes
 *  any query parameter on a <Sip> address through as a header; names must
 *  start with X-. */
export const CALL_HEADER = 'X-Cactus-Call'
export const CALL_SIGNATURE_HEADER = 'X-Cactus-Sig'

/** Proves a call reference came from this site. Anybody who learns the
 *  project's SIP address can ring it, and what they say in a SIP header is
 *  theirs to choose; without this, a stranger could name somebody else's call
 *  and borrow the orders that caller had proved were theirs. */
export function callSignature(callSid: string, secret: string): string {
  return createHmac('sha256', secret).update(`live-call:${callSid}`).digest('hex').slice(0, 32)
}

export function callSignatureMatches(callSid: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(callSignature(callSid, secret))
  const given = Buffer.from(signature)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** The address Twilio dials, with the call reference and its signature.
 *
 *  `secure=true` is what makes Twilio encrypt the call audio (SRTP) as well as
 *  the signalling. `transport=tls` alone only covers the signalling, and
 *  GPT-Live refuses such a call at accept with "Live SIP calls require SRTP",
 *  which sends every caller to voicemail. Both are kept: `secure=true` implies
 *  TLS, and saying so does no harm. */
export function liveSipUri(projectId: string, region: LiveRegion, callSid: string, secret: string): string {
  const headers = new URLSearchParams({
    [CALL_HEADER]: callSid,
    [CALL_SIGNATURE_HEADER]: callSignature(callSid, secret),
  })
  return `sip:${projectId}@${SIP_HOSTS[region]};transport=tls;secure=true?${headers.toString()}`
}

/** Reads one header from the webhook's list, ignoring case. The list is the
 *  caller's to fill, so nothing in it is trusted until checked. */
export function sipHeader(headers: ReadonlyArray<{ name: string; value: string }>, name: string): string {
  const wanted = name.toLowerCase()
  return headers.find((header) => header.name.toLowerCase() === wanted)?.value.trim() ?? ''
}

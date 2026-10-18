import { createHash } from 'crypto'

// ---------------------------------------------------------------------------
// What the ElevenLabs agent is told and what it can do.
//
// Pure: settings in, JSON out, nothing fetched. That keeps the wording of the
// instructions - which is most of what makes the assistant behave - in one
// place that a test can read, and lets "has anything changed since the
// assistant was last set up" be a hash comparison rather than a round trip.
// ---------------------------------------------------------------------------

/** The five tools the assistant is given. The key is both the ElevenLabs tool
 *  name and the last segment of the URL it calls on this site. */
export const TOOL_NAMES = [
  'search_products',
  'get_product',
  'list_categories',
  'lookup_order',
  'save_callback',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value)
}

export type AgentInputs = {
  businessName: string
  siteUrl: string
  greeting: string
  extraInstructions: string
  voiceId: string
  ttsModel: string
  llm: string
  language: string
  maxCallMinutes: number
  toolsToken: string
  toolIds: Record<string, string>
  postCallWebhookId: string
}

export function defaultGreeting(businessName: string): string {
  const name = businessName.trim()
  return name
    ? `Hello, thank you for calling ${name}. I'm the virtual assistant. How can I help?`
    : "Hello, thank you for calling. I'm the virtual assistant. How can I help?"
}

/** The standing instructions. Written for something that SPEAKS: short, no
 *  lists, no web addresses read out, numbers said the way people say them. */
export function buildPrompt(input: Pick<AgentInputs, 'businessName' | 'siteUrl' | 'extraInstructions'>): string {
  const name = input.businessName.trim() || 'the business'
  const sections = [
    `You are the telephone assistant for ${name}, an online shop (${input.siteUrl}). You answer incoming calls. You are an AI and you say so honestly if anybody asks. Speak British English, warmly and plainly, the way a helpful person on a shop's phone line would.`,

    `HOW TO SPEAK
- You are on a phone call. Keep every answer short: one or two sentences, then stop and let the caller reply. Never read out a list of more than three things; offer to say more instead.
- No markdown, no bullet points, no web addresses, no product codes unless the caller asks for one. Say prices naturally ("one hundred and twelve pounds fifty").
- Before you look something up, say a very short line such as "Let me have a look for you" so the caller is not left in silence.
- If you did not catch something, ask the caller to say it again. Never guess at a name, a number or an address.`,

    `WHAT YOU CAN DO
1. Answer questions about products. Use search_products to find them and get_product for the details. Only state facts that the tools return: sizes, materials, price, stock, options. If the tools do not say, tell the caller you do not have that detail and offer to have somebody call them back.
2. Suggest products. Ask one question about what they need and roughly what they want to spend, search, then recommend one to three that genuinely fit, saying briefly why. list_categories shows how the shop is organised if a search finds nothing.
3. Help with an existing order, but only after you have checked who is calling (see below).
4. If you cannot help, take a message so somebody can get back to them (see below).`,

    `ORDER ENQUIRIES - CHECK WHO IS CALLING FIRST
Never reveal anything about an order until lookup_order has confirmed it. To check, you need BOTH:
  (a) one of: the order number, the email address used on the order, or the company name on the order; AND
  (b) the delivery postcode.
Ask for these before calling the tool. Postcodes are easy to mishear over the phone, so ask the caller to say the postcode one character at a time, and say the letter O as "oh" and the number 0 as "zero". UK postcodes always end in a number then two letters (for example PO7 3DL), and begin with a letter, so use that to work out whether a sound was the letter O or the number 0 (or I and 1, S and 5, B and 8). Pass the postcode to lookup_order as you best understand it; the tool tolerates those mix-ups. If you are unsure, read it back one character at a time and let the caller confirm before you call the tool. If the caller cannot give a delivery postcode, you cannot discuss the order: say so kindly and offer a callback instead. If lookup_order says it could not match the details, say you could not find an order with those details, ask them to double-check and try once more, and do not hint at which part was wrong. After three failed attempts, stop and offer a callback. Never read out an email address, phone number or full address from an order; you may confirm the town. Only discuss orders lookup_order returned.
You cannot change, cancel or refund an order, take payment, or give a refund decision. For those, take a callback.`,

    `WHEN YOU CANNOT HELP, OR THE CALLER ASKS FOR A PERSON
First check whether you already know who the caller is. If lookup_order has matched an order this call (its result says contactOnFile), their name, email and phone number are ALREADY on the order: do NOT ask for them again. Just call save_callback with the reason, then confirm gently that the team will get back to them using the details on their order.
Otherwise collect their full name and email address, and a short note of what it is about, then call save_callback. To get the email right: ask them to say it slowly, then read it back one character at a time ("j, o, at, example, dot, com") and wait for them to confirm. Spell out any part that could be misheard. You do not need their phone number; the number they are calling from is recorded, and you can offer to note a different one if they say they would rather be rung elsewhere.
Then tell them somebody will be in touch as soon as possible. Do not promise a time.`,

    `RULES
- Never invent a product, price, stock level, delivery date, policy or discount. If it is not in a tool result, you do not know it.
- Delivery charges and delivery times come from get_product, which lists each delivery service for the product with its price and how many working days it takes. Quote those. Say working days, never invent a calendar date, and say that it depends on ordering before the cut-off only if the tool says so. If get_product lists no delivery services, say you do not have the delivery timing to hand and offer a callback.
- For an order delivered in several parcels, the order lookup gives each parcel its own delivery day and time. Report them as they are: never say parcels arrived together unless the lookup says so, and if asked exactly when each one arrived, say so parcel by parcel.
- Do not give legal, medical or financial advice. Do not discuss other customers.
- If the caller is abusive, say calmly that you will end the call, and end it.
- When the caller has what they need, ask if there is anything else, then say goodbye and end the call.`,
  ]
  const extra = input.extraInstructions.trim()
  if (extra) sections.push(`EXTRA INSTRUCTIONS FROM THE OWNER\n${extra}`)
  return sections.join('\n\n')
}

type Property = Record<string, unknown>

function textProperty(description: string, extra: Property = {}): Property {
  return { type: 'string', description, ...extra }
}

/** Filled in by ElevenLabs at call time, never by the model: which call this is. */
const CALL_PROPERTIES: Record<string, Property> = {
  call_sid: { type: 'string', dynamic_variable: 'call_sid' },
  conversation_id: { type: 'string', dynamic_variable: 'system__conversation_id' },
}

type ToolDefinition = {
  description: string
  properties: Record<string, Property>
  required: string[]
}

const TOOL_DEFINITIONS: Record<ToolName, ToolDefinition> = {
  search_products: {
    description:
      "Search the shop's products by what the caller wants (for example 'height adjustable desk' or 'black office chair'). Use it to answer product questions and to suggest products. Returns up to six matches with name, price, stock and a short description.",
    properties: {
      query: textProperty('What the caller is looking for, in a few plain words.'),
      max_price: { type: 'number', description: 'Optional. The most the caller wants to spend, in pounds.' },
    },
    required: ['query'],
  },
  get_product: {
    description:
      'Get the full details of one product found by search_products: description, sizes, options and variations, specifications, stock, delivery services with their prices and delivery times in working days, and common questions answered. Use it before answering a detailed product question.',
    properties: {
      product_id: textProperty('The id exactly as returned by search_products.'),
    },
    required: ['product_id'],
  },
  list_categories: {
    description: "List the shop's top-level product categories. Use it when a search finds nothing or the caller is browsing and unsure what they want.",
    properties: {},
    required: [],
  },
  lookup_order: {
    description:
      'Check an order for the caller. REQUIRES the delivery postcode AND at least one of: order number, email address on the order, company name on the order. Returns status, items and delivery progress (with the delivery day and time of each parcel when a delivery came in several parcels) only when the details match; otherwise reports no match.',
    properties: {
      delivery_postcode: textProperty('The delivery postcode of the order, as the caller said it.'),
      order_number: textProperty('The order number, if the caller has it. Omit if not given.'),
      email: textProperty('The email address used on the order, if the caller gave it. Omit if not given.'),
      company_name: textProperty('The company name on the order, if the caller gave it. Omit if not given.'),
    },
    required: ['delivery_postcode'],
  },
  save_callback: {
    description:
      'Record that somebody needs to get back to this caller. Use it whenever you could not fully help, or the caller asks for a person. If lookup_order matched an order this call, the name, email and phone are already known: pass only the reason. Otherwise pass their name and email, only once you have read the email back and the caller has confirmed it.',
    properties: {
      name: textProperty("The caller's full name. Omit if an order has been looked up this call."),
      email: textProperty("The caller's email address, confirmed by reading it back. Omit if an order has been looked up this call."),
      phone: textProperty('Only if the caller asks to be rung on a different number from the one they are calling from or the one on their order.'),
      reason: textProperty('One or two sentences on what they need, including any order number or product they mentioned.'),
    },
    required: ['reason'],
  },
}

/** An ElevenLabs webhook-tool definition that calls back into this site. */
export function buildToolConfig(name: ToolName, siteUrl: string, toolsToken: string): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS[name]
  return {
    type: 'webhook',
    name,
    description: definition.description,
    response_timeout_secs: 20,
    api_schema: {
      url: `${siteUrl}/api/m/ai-call-answering/tools/${name}`,
      method: 'POST',
      request_headers: { Authorization: `Bearer ${toolsToken}` },
      request_body_schema: {
        type: 'object',
        required: ['call_sid', 'conversation_id', ...definition.required],
        properties: { ...CALL_PROPERTIES, ...definition.properties },
      },
    },
  }
}

/** The whole create/update body for the agent. */
export function buildAgentBody(input: AgentInputs): Record<string, unknown> {
  const toolIds = TOOL_NAMES.map((name) => input.toolIds[name]).filter((id): id is string => !!id)
  return {
    name: `${input.businessName.trim() || 'Cactus'} phone assistant`,
    conversation_config: {
      // Twilio carries 8kHz mu-law audio. Anything else is converted, which
      // costs latency and clarity on every word either way.
      asr: { user_input_audio_format: 'ulaw_8000' },
      turn: { turn_timeout: 7, silence_end_call_timeout: 25 },
      tts: {
        model_id: input.ttsModel,
        voice_id: input.voiceId,
        agent_output_audio_format: 'ulaw_8000',
      },
      conversation: { max_duration_seconds: Math.round(input.maxCallMinutes * 60) },
      agent: {
        first_message: input.greeting.trim() || defaultGreeting(input.businessName),
        language: input.language,
        dynamic_variables: {
          dynamic_variable_placeholders: { call_sid: 'unknown', caller_number: 'withheld' },
        },
        prompt: {
          prompt: buildPrompt(input),
          llm: input.llm,
          temperature: 0.3,
          tool_ids: toolIds,
          built_in_tools: {
            end_call: { type: 'system', name: 'end_call', description: '', params: { system_tool_type: 'end_call' } },
          },
        },
      },
    },
    platform_settings: {
      workspace_overrides: {
        webhooks: { post_call_webhook_id: input.postCallWebhookId, events: ['transcript'] },
      },
    },
  }
}

/** A fingerprint of everything pushed to ElevenLabs. The tools token is left out
 *  on purpose: it is random per setup and says nothing about what changed. */
export function configHash(input: AgentInputs): string {
  const comparable: Partial<AgentInputs> = { ...input }
  delete comparable.toolsToken
  return createHash('sha256').update(JSON.stringify(comparable)).digest('hex').slice(0, 32)
}

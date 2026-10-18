import { describe, expect, it } from 'vitest'
import {
  TOOL_NAMES,
  buildAgentBody,
  buildPrompt,
  buildToolConfig,
  configHash,
  defaultGreeting,
  isToolName,
  type AgentInputs,
} from './agent-config'

const inputs: AgentInputs = {
  businessName: 'Deskwell',
  siteUrl: 'https://example.co.uk',
  greeting: '',
  extraInstructions: '',
  voiceId: 'voice123',
  ttsModel: 'eleven_v4',
  llm: 'claude-sonnet-5-5',
  language: 'en',
  maxCallMinutes: 15,
  toolsToken: 'secret-token',
  toolIds: Object.fromEntries(TOOL_NAMES.map((name) => [name, `id_${name}`])),
  postCallWebhookId: 'wh_1',
}

describe('buildPrompt', () => {
  it('insists on order verification and callback collection', () => {
    const prompt = buildPrompt(inputs)
    expect(prompt).toContain('delivery postcode')
    expect(prompt).toContain('save_callback')
    expect(prompt).toContain('Deskwell')
  })
  it('offers an emailed summary that never carries order details', () => {
    const prompt = buildPrompt(inputs)
    expect(prompt).toContain('email_summary')
    expect(prompt).toContain('NEVER put order details')
  })
  it('appends the owner instructions last', () => {
    const prompt = buildPrompt({ ...inputs, extraInstructions: 'Never mention Brexit.' })
    expect(prompt.endsWith('Never mention Brexit.')).toBe(true)
  })
})

describe('buildToolConfig', () => {
  it('points at this site with the bearer token and call identity filled by the platform', () => {
    const tool = buildToolConfig('lookup_order', inputs.siteUrl, inputs.toolsToken) as {
      api_schema: {
        url: string
        request_headers: Record<string, string>
        request_body_schema: { required: string[]; properties: Record<string, { dynamic_variable?: string }> }
      }
    }
    expect(tool.api_schema.url).toBe('https://example.co.uk/api/m/ai-call-answering/tools/lookup_order')
    expect(tool.api_schema.request_headers.Authorization).toBe('Bearer secret-token')
    expect(tool.api_schema.request_body_schema.properties.call_sid?.dynamic_variable).toBe('call_sid')
    expect(tool.api_schema.request_body_schema.properties.conversation_id?.dynamic_variable).toBe('system__conversation_id')
    expect(tool.api_schema.request_body_schema.required).toContain('delivery_postcode')
  })
  it('never lets the model supply the call identity', () => {
    for (const name of TOOL_NAMES) {
      const tool = buildToolConfig(name, inputs.siteUrl, 'x') as {
        api_schema: { request_body_schema: { properties: Record<string, { description?: string }> } }
      }
      expect(tool.api_schema.request_body_schema.properties.call_sid?.description).toBeUndefined()
    }
  })
  it('describes every array item, which ElevenLabs insists on', () => {
    for (const name of TOOL_NAMES) {
      const tool = buildToolConfig(name, inputs.siteUrl, 'x') as {
        api_schema: { request_body_schema: { properties: Record<string, { type?: string; items?: { description?: string } }> } }
      }
      for (const prop of Object.values(tool.api_schema.request_body_schema.properties)) {
        if (prop.type === 'array') expect(prop.items?.description).toBeTruthy()
      }
    }
  })
})

describe('buildAgentBody', () => {
  const body = buildAgentBody(inputs) as {
    conversation_config: {
      asr: { user_input_audio_format: string }
      tts: { model_id: string; agent_output_audio_format: string }
      agent: { first_message: string; prompt: { tool_ids: string[] } }
    }
    platform_settings: { workspace_overrides: { webhooks: { post_call_webhook_id: string } } }
  }
  it('speaks telephone audio with the chosen voice model', () => {
    expect(body.conversation_config.asr.user_input_audio_format).toBe('ulaw_8000')
    expect(body.conversation_config.tts.agent_output_audio_format).toBe('ulaw_8000')
    expect(body.conversation_config.tts.model_id).toBe('eleven_v4')
  })
  it('attaches every tool and the post-call webhook', () => {
    expect(body.conversation_config.agent.prompt.tool_ids).toHaveLength(TOOL_NAMES.length)
    expect(body.platform_settings.workspace_overrides.webhooks.post_call_webhook_id).toBe('wh_1')
  })
  it('falls back to a stock greeting', () => {
    expect(body.conversation_config.agent.first_message).toBe(defaultGreeting('Deskwell'))
  })
})

describe('configHash', () => {
  it('changes with the voice but not with the token', () => {
    expect(configHash(inputs)).toBe(configHash({ ...inputs, toolsToken: 'another' }))
    expect(configHash(inputs)).not.toBe(configHash({ ...inputs, voiceId: 'other' }))
  })
})

describe('isToolName', () => {
  it('knows its tools', () => {
    expect(isToolName('lookup_order')).toBe(true)
    expect(isToolName('drop_table')).toBe(false)
  })
})

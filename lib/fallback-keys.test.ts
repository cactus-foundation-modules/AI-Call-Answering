import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/db/prisma', () => ({ prisma: {} }))
vi.mock('@/lib/crypto/secrets', () => ({ encryptSecret: (v: string) => v, tryDecryptSecret: (v: string | null) => v }))

import { ElevenLabsError } from './elevenlabs'
import {
  COOLDOWN_MS,
  callCandidates,
  isKeyProblem,
  knownAgentIds,
  orderCandidates,
  webhookSecrets,
  type FallbackKey,
} from './fallback-keys'
import type { AiCallSettings } from './settings'

const settings = { apiKey: 'main-key', agentId: 'agent-main', webhookSecret: 'secret-main' } as AiCallSettings

function fallback(id: string, over: Partial<FallbackKey> = {}): FallbackKey {
  return {
    id, label: id, apiKey: `${id}-key`, agentId: `agent-${id}`, postCallWebhookId: `wh-${id}`,
    webhookSecret: `secret-${id}`, toolIds: {}, syncedHash: '', syncedAt: null, ...over,
  }
}

describe('callCandidates', () => {
  it('puts the main key first and skips fallbacks that are not set up', () => {
    const out = callCandidates(settings, [fallback('a'), fallback('b', { agentId: null })])
    expect(out.map((c) => c.id)).toEqual(['main', 'a'])
  })

  it('lets a fallback answer when the main key has gone', () => {
    const out = callCandidates({ ...settings, apiKey: null }, [fallback('a')])
    expect(out.map((c) => c.id)).toEqual(['a'])
  })

  it('is empty with nothing set up', () => {
    expect(callCandidates({ ...settings, agentId: null }, [])).toEqual([])
  })
})

describe('orderCandidates', () => {
  const candidates = callCandidates(settings, [fallback('a'), fallback('b')])

  it('keeps the order when nothing is cooling', () => {
    expect(orderCandidates(candidates, new Map(), 1000).map((c) => c.id)).toEqual(['main', 'a', 'b'])
  })

  it('moves a refused key to the back until the cooldown ends', () => {
    const cooling = new Map([['main', 1000 + COOLDOWN_MS]])
    expect(orderCandidates(candidates, cooling, 1000).map((c) => c.id)).toEqual(['a', 'b', 'main'])
    expect(orderCandidates(candidates, cooling, 1000 + COOLDOWN_MS + 1).map((c) => c.id)).toEqual(['main', 'a', 'b'])
  })
})

describe('isKeyProblem', () => {
  it('is true for credit, auth and rate refusals only', () => {
    for (const status of [401, 402, 403, 429]) expect(isKeyProblem(new ElevenLabsError('x', status))).toBe(true)
    for (const status of [0, 404, 422, 500]) expect(isKeyProblem(new ElevenLabsError('x', status))).toBe(false)
    expect(isKeyProblem(new Error('x'))).toBe(false)
  })
})

describe('webhook trust', () => {
  it('accepts every account\'s secret and agent', () => {
    const fallbacks = [fallback('a'), fallback('b', { webhookSecret: null, agentId: null })]
    expect(webhookSecrets(settings, fallbacks)).toEqual(['secret-main', 'secret-a'])
    expect(knownAgentIds(settings, fallbacks)).toEqual(['agent-main', 'agent-a'])
  })
})

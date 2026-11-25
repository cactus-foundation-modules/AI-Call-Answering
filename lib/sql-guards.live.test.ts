import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TestDatabase, TestRole, VpsConfig } from '@/lib/backup/vps-database'

// This module's raw SQL, ACTUALLY EXECUTED by Postgres.
//
// Nothing else runs it. `tsc` and `eslint` see template strings, `npm test`
// never opens a connection, and the module build gate builds without executing
// a query - so a statement Postgres will not parse passes every gate there is
// and fails for the first time on a live site.
//
// Covers every statement that touches this module's own tables: settings
// (encrypted secrets, tool ids), number assignments, the call record from
// opening to completion (with the products it was about), the inbox
// provider's listing, paging and thread, and the post-call filing. Shop reads are covered separately by running them
// against a copy of a real catalogue; they never write.
//
// It provisions its OWN throwaway database on the self-hosted Postgres VPS
// (`cactus_rt_*`, owned by a throwaway role, dropped afterwards) so it never
// touches a real database. Skipped unless opted into:
//
//   npm run test:ai-call-sql
//
// A SKIP IS A FAIL for a release that touches this module's SQL.
const shouldRun = process.env.RUN_AI_CALL_SQL === '1'
const suite = shouldRun ? describe : describe.skip

function moduleSql(): string[] {
  const dir = path.join(process.cwd(), 'modules', 'ai-call-answering', 'migrations')
  return readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .flatMap((file) =>
      readFileSync(path.join(dir, file), 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .split(/;\s*\n/)
        .map((statement) => statement.trim())
        .filter(Boolean),
    )
}

suite('ai-call-answering SQL, against a real Postgres', () => {
  let cfg: VpsConfig
  let role: TestRole
  let database: TestDatabase
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const dbName = `cactus_rt_aicall_${stamp}`
  const roleName = `cactus_rt_role_aicall_${stamp}`

  type Loaded = {
    prisma: typeof import('@/lib/db/prisma')
    settings: typeof import('./settings')
    numbers: typeof import('./numbers')
    calls: typeof import('./calls')
    provider: typeof import('./conversation-provider')
    postCall: typeof import('./post-call')
    basket: typeof import('./phone-basket')
  }
  let mod: Loaded
  let vps: typeof import('@/lib/backup/vps-database')

  beforeAll(async () => {
    vps = await import('@/lib/backup/vps-database')
    cfg = vps.vpsConfigFromEnv()
    role = await vps.createTestRole(cfg, roleName)
    database = await vps.createTestDatabase(cfg, dbName, role)
    process.env.DATABASE_URL = database.connectionUri
    process.env.DIRECT_URL = database.connectionUri
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32)
    delete process.env.ELEVENLABS_API_KEY
    delete process.env.OPENAI_API_KEY

    mod = {
      prisma: await import('@/lib/db/prisma'),
      settings: await import('./settings'),
      numbers: await import('./numbers'),
      calls: await import('./calls'),
      provider: await import('./conversation-provider'),
      postCall: await import('./post-call'),
      basket: await import('./phone-basket'),
    }

    for (let attempt = 0; ; attempt++) {
      try {
        await mod.prisma.prisma.$queryRawUnsafe('SELECT 1')
        break
      } catch (err) {
        if (attempt >= 15) throw err
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    for (const statement of moduleSql()) await mod.prisma.prisma.$executeRawUnsafe(statement)
  }, 300_000)

  afterAll(async () => {
    await mod?.prisma.prisma.$disconnect().catch(() => {})
    if (!cfg) return
    if (database) await vps.dropTestDatabase(cfg, database.name).catch(() => {})
    if (role) await vps.dropTestRole(cfg, role.name).catch(() => {})
  }, 300_000)

  it('migrations are idempotent', async () => {
    for (const statement of moduleSql()) await mod.prisma.prisma.$executeRawUnsafe(statement)
  })

  it('reads defaults before anything is saved', async () => {
    const settings = await mod.settings.getSettings()
    expect(settings.enabled).toBe(false)
    expect(settings.ttsModel).toBe('eleven_v4')
    expect(settings.toolIds).toEqual({})
    expect(settings.apiKey).toBeNull()
  })

  it('round-trips settings, encrypted secrets and tool ids', async () => {
    await mod.settings.updateSettings({
      apiKey: 'sk_test_key', businessName: 'Deskwell', voiceId: 'voice1', maxCallMinutes: 9,
      greeting: 'Hi', extraInstructions: 'Be nice', llm: 'claude-haiku-5-5', language: 'en',
    })
    await mod.settings.saveWebhook('wh_1', 'whsec_1')
    await mod.settings.saveProvisionedState({
      agentId: 'agent_1', postCallWebhookId: 'wh_1', webhookSecret: null, toolsToken: 'tok',
      toolIds: { search_products: 't1', lookup_order: 't2' }, syncedHash: 'abc',
    })
    await mod.settings.updateSettings({ enabled: true })
    const settings = await mod.settings.getSettings()
    expect(settings).toMatchObject({
      enabled: true, apiKey: 'sk_test_key', businessName: 'Deskwell', agentId: 'agent_1', toolsToken: 'tok',
      webhookSecret: 'whsec_1', postCallWebhookId: 'wh_1', maxCallMinutes: 9, llm: 'claude-haiku-5-5', syncedHash: 'abc',
    })
    expect(settings.toolIds).toEqual({ search_products: 't1', lookup_order: 't2' })
    expect(settings.syncedAt).toBeInstanceOf(Date)

    const raw = await mod.prisma.prisma.$queryRawUnsafe<Array<{ api_key_encrypted: string }>>('SELECT api_key_encrypted FROM acall_settings')
    expect(raw[0]?.api_key_encrypted).not.toContain('sk_test_key')

    await mod.settings.updateSettings({ clearApiKey: true })
    expect((await mod.settings.getSettings()).apiKey).toBeNull()
  })

  it('assigns numbers', async () => {
    await mod.numbers.saveAssignment({ phoneSid: 'PN1', phoneNumber: '+441234567890', enabled: true, mode: 'when_unattended' })
    await mod.numbers.saveAssignment({ phoneSid: 'PN1', phoneNumber: '+441234567890', enabled: true, mode: 'always' })
    expect(await mod.numbers.getAssignmentForNumber('+441234567890')).toMatchObject({ enabled: true, mode: 'always' })
    expect(await mod.numbers.getAssignmentForNumber('+449999999999')).toBeNull()
    expect(await mod.numbers.listAssignments()).toHaveLength(1)
  })

  let callId = ''

  it('opens a call once however often Twilio asks', async () => {
    await mod.calls.openCall({ callSid: 'CA1', fromNumber: '+447700900123', toNumber: '+441234567890' })
    await mod.calls.openCall({ callSid: 'CA1', fromNumber: '+447700900123', toNumber: '+441234567890' })
    const call = await mod.calls.findCall({ callSid: 'CA1' })
    expect(call).toMatchObject({ status: 'in_progress', fromNumber: '+447700900123', failedOrderChecks: 0, verifiedOrders: [] })
    callId = call!.id
    const count = await mod.prisma.prisma.$queryRawUnsafe<Array<{ n: bigint }>>('SELECT count(*) AS n FROM acall_calls')
    expect(Number(count[0]?.n)).toBe(1)
  })

  it('links a conversation id and finds the call by it', async () => {
    await mod.calls.linkConversation(callId, 'conv_1')
    expect((await mod.calls.findCall({ conversationId: 'conv_1' }))?.id).toBe(callId)
  })

  it('records callbacks, verified orders and failed checks', async () => {
    await mod.calls.recordVerifiedOrder(callId, 'DW-1')
    await mod.calls.recordVerifiedOrder(callId, 'DW-1')
    await mod.calls.recordVerifiedOrder(callId, 'DW-2')
    await mod.calls.recordFailedOrderCheck(callId)
    await mod.calls.recordFailedOrderCheck(callId)
    await mod.calls.recordVerifiedContact(callId, { name: 'Jo Bloggs', email: 'jo@example.com', phone: '+447700900999' })
    await mod.calls.recordCallback(callId, { name: 'Jo Bloggs', email: 'jo@example.com', phone: '+447700900999', reason: 'Bulk quote' })
    const call = await mod.calls.getCall(callId)
    expect(call).toMatchObject({ verifiedOrders: ['DW-1', 'DW-2'], failedOrderChecks: 2, callbackNeeded: true, callerName: 'Jo Bloggs', callerEmail: 'jo@example.com', callerPhone: '+447700900999', verifiedContact: { email: 'jo@example.com' } })
    expect(await mod.calls.recentFailedChecksFrom('+447700900123')).toBe(2)
    expect(await mod.calls.recentFailedChecksFrom('+440000000000')).toBe(0)
    expect(await mod.calls.recentFailedChecksFrom('')).toBe(0)
  })

  it('keeps the products a call was about, and reads them back with the call', async () => {
    expect((await mod.calls.getCall(callId))?.discussedProducts).toEqual([])
    const list = [{ id: 'chair', parentId: null }, { id: 'desk-black', parentId: 'desk' }]
    await mod.calls.saveDiscussedProducts(callId, list)
    expect((await mod.calls.findCall({ callSid: 'CA1' }))?.discussedProducts).toEqual(list)
    await mod.calls.saveDiscussedProducts(callId, Array.from({ length: 14 }, (_, i) => ({ id: `p${i}`, parentId: null })))
    const kept = (await mod.calls.getCall(callId))?.discussedProducts ?? []
    expect(kept).toHaveLength(10)
    expect(kept[9]?.id).toBe('p13')
  })

  it('completes a call with a transcript', async () => {
    await mod.calls.completeCall(callId, {
      conversationId: 'conv_1', durationSeconds: 95, summary: 'Asked about desks.',
      transcript: [{ role: 'assistant', text: 'Hello', at: 0 }, { role: 'caller', text: 'Desks?', at: 3 }],
      startedAt: new Date('2026-10-18T10:00:00Z'),
    })
    const call = await mod.calls.getCall(callId)
    expect(call).toMatchObject({ status: 'completed', durationSeconds: 95, summary: 'Asked about desks.' })
    expect(call?.transcript).toHaveLength(2)
    expect(call?.startedAt.toISOString()).toBe('2026-10-18T10:00:00.000Z')
  })

  it('handles and reads', async () => {
    await mod.calls.setHandled(callId, true)
    expect((await mod.calls.getCall(callId))?.handledAt).toBeInstanceOf(Date)
    await mod.calls.setHandled(callId, false)
    expect((await mod.calls.getCall(callId))?.handledAt).toBeNull()
    await mod.calls.markRead(callId)
    expect((await mod.calls.getCall(callId))?.readAt).toBeInstanceOf(Date)
    expect((await mod.calls.listRecentCalls(10)).map((c) => c.id)).toContain(callId)
  })

  it('publishes to the inbox: list, page, thread, identity, read', async () => {
    for (let n = 2; n <= 4; n++) {
      await mod.calls.openCall({ callSid: `CA${n}`, fromNumber: `+4477009005${n}0`, toNumber: '+441234567890' })
    }
    const provider = mod.provider.aiCallConversationProvider
    const first = await provider.list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    const second = await provider.list({ limit: 2, cursor: first.nextCursor })
    expect(second.items).toHaveLength(2)
    const seen = new Set([...first.items, ...second.items].map((item) => item.id))
    expect(seen.size).toBe(4)
    expect(second.nextCursor).toBeUndefined()

    const future = await provider.list({ limit: 10, since: new Date(Date.now() + 60_000) })
    expect(future.items).toHaveLength(0)

    const thread = await provider.thread(callId)
    expect(thread?.messages).toHaveLength(2)
    expect(thread?.messages[0]?.text).toContain('CALLBACK REQUESTED')
    expect(thread?.summary).toMatchObject({ channel: 'phone', status: 'open' })
    expect(await provider.thread('does-not-exist')).toBeNull()

    const byEmail = await provider.byIdentity!({ emails: ['JO@example.com'], phones: [] })
    expect(byEmail.map((item) => item.id)).toEqual([callId])
    const byPhone = await provider.byIdentity!({ emails: [], phones: ['+447700900123'] })
    expect(byPhone.map((item) => item.id)).toEqual([callId])
    expect(await provider.byIdentity!({ emails: [], phones: [] })).toEqual([])
    await provider.markRead!(callId)
  })

  it('files a finished call from the post-call payload, and ignores other agents', async () => {
    await mod.settings.saveProvisionedState({
      agentId: 'agent_1', postCallWebhookId: 'wh_1', webhookSecret: null, toolsToken: 'tok', toolIds: {}, syncedHash: 'x',
    })
    const payload = (agentId: string, sid: string, conversationId: string) => mod.postCall.parsePostCallPayload(JSON.stringify({
      type: 'post_call_transcription',
      data: {
        agent_id: agentId, conversation_id: conversationId,
        transcript: [{ role: 'user', message: 'Where is my order', time_in_call_secs: 2 }],
        metadata: { start_time_unix_secs: 1_800_000_000, call_duration_secs: 30 },
        analysis: { transcript_summary: '' },
        conversation_initiation_client_data: { dynamic_variables: { call_sid: sid, caller_number: '+447700900999' } },
      },
    }))!
    expect((await mod.postCall.ingestPostCall(payload('someone_else', 'CA9', 'conv_9'))).status).toBe('ignored')
    const filed = await mod.postCall.ingestPostCall(payload('agent_1', 'CA9', 'conv_9'))
    expect(filed.status).toBe('filed')
    const call = await mod.calls.findCall({ conversationId: 'conv_9' })
    expect(call).toMatchObject({ status: 'completed', fromNumber: '+447700900999', durationSeconds: 30 })
    expect(call?.summary).toContain('Where is my order')

    const again = await mod.postCall.ingestPostCall(payload('agent_1', 'CA9', 'conv_9'))
    expect(again.status).toBe('filed')
    const count = await mod.prisma.prisma.$queryRawUnsafe<Array<{ n: bigint }>>("SELECT count(*) AS n FROM acall_calls WHERE call_sid = 'CA9'")
    expect(Number(count[0]?.n)).toBe(1)
  })

  it('round-trips the GPT-Live settings and refuses an unknown engine', async () => {
    const before = await mod.settings.getSettings()
    expect(before).toMatchObject({ engine: 'elevenlabs', openaiApiKey: null, openaiProjectId: '', liveVoice: 'marin', liveBackendModel: 'gpt-6-luna', liveRegion: 'global' })
    expect(mod.settings.liveReady(before)).toBe(false)
    await mod.settings.updateSettings({
      engine: 'gpt-live', openaiApiKey: 'sk-proj-test', openaiProjectId: 'proj_abc123', openaiWebhookSecret: 'whsec_c2VjcmV0',
      liveVoice: 'cedar', liveBackendModel: 'gpt-6-sol', liveRegion: 'eu',
    })
    const after = await mod.settings.getSettings()
    expect(after).toMatchObject({ engine: 'gpt-live', openaiApiKey: 'sk-proj-test', openaiProjectId: 'proj_abc123', openaiWebhookSecret: 'whsec_c2VjcmV0', liveVoice: 'cedar', liveBackendModel: 'gpt-6-sol', liveRegion: 'eu' })
    expect(mod.settings.liveReady(after)).toBe(true)
    expect(mod.settings.engineReady(after)).toBe(true)
    const stored = await mod.prisma.prisma.$queryRawUnsafe<Array<{ k: string | null }>>(`SELECT openai_api_key_encrypted AS k FROM acall_settings`)
    expect(stored[0]?.k).not.toContain('sk-proj-test')
    await mod.settings.updateSettings({ clearOpenaiApiKey: true })
    expect((await mod.settings.getSettings()).openaiApiKey).toBeNull()
    await expect(mod.prisma.prisma.$executeRawUnsafe(`UPDATE acall_settings SET engine = 'nonsense'`)).rejects.toThrow()
    await mod.settings.updateSettings({ engine: 'elevenlabs' })
  })

  it('claims a GPT-Live call once, only for its own open call, and keeps its usage', async () => {
    await mod.calls.openCall({ callSid: 'CALIVE', fromNumber: '+447700900777', toNumber: '+441234567890', engine: 'gpt-live' })
    await mod.calls.openCall({ callSid: 'CAEL', fromNumber: '+447700900778', toNumber: '+441234567890' })
    expect(await mod.calls.claimLiveCall('CAEL', 'live_x')).toBeNull()
    expect(await mod.calls.claimLiveCall('CANONE', 'live_x')).toBeNull()
    const claimed = await mod.calls.claimLiveCall('CALIVE', 'live_1')
    expect(claimed).toMatchObject({ callSid: 'CALIVE', conversationId: 'live_1', status: 'in_progress' })
    // A second session naming the same call, or a retried webhook, gets nothing.
    expect(await mod.calls.claimLiveCall('CALIVE', 'live_2')).toBeNull()
    expect((await mod.calls.findCall({ conversationId: 'live_1' }))?.callSid).toBe('CALIVE')

    await mod.calls.recordUsage(claimed!.id, { seconds: 61, inputTokens: 12000, cachedTokens: 10800, outputTokens: 300, responses: 4 })
    const usage = await mod.prisma.prisma.$queryRawUnsafe<Array<{ usage: unknown; engine: string; live_session_id: string }>>(
      `SELECT usage, engine, live_session_id FROM acall_calls WHERE call_sid = 'CALIVE'`,
    )
    expect(usage[0]).toMatchObject({ engine: 'gpt-live', live_session_id: 'live_1', usage: { seconds: 61, cachedTokens: 10800 } })

    await mod.calls.completeCall(claimed!.id, { conversationId: 'live_1', durationSeconds: 61, summary: 'Asked about chairs.', transcript: [], startedAt: null })
    await mod.prisma.prisma.$executeRawUnsafe(`UPDATE acall_calls SET live_session_id = NULL WHERE call_sid = 'CALIVE'`)
    expect(await mod.calls.claimLiveCall('CALIVE', 'live_3')).toBeNull()
  })

  it('keeps a phone basket, records its quote, and lets the quote go when the lines change', async () => {
    await mod.calls.openCall({ callSid: 'CABASKET', fromNumber: '+447700900124', toNumber: '+441234567890' })
    const call = await mod.calls.findCall({ callSid: 'CABASKET' })
    const lines = [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }]
    const { token } = await mod.basket.saveCallBasket(call!.id, lines)
    expect(await mod.basket.getCallBasket(call!.id)).toEqual({ token, lines, quote: null, quotesSaved: 0 })

    await mod.basket.recordBasketQuote(call!.id, { id: 'q1', number: 'QUO-1', url: 'https://shop.test/quote/AB3XY9', emailed: true })
    const saved = await mod.basket.getCallBasket(call!.id)
    expect(saved?.quote).toEqual({ id: 'q1', number: 'QUO-1', url: 'https://shop.test/quote/AB3XY9', emailed: true })
    expect(saved?.quotesSaved).toBe(1)

    // The same lines again (a retried tool call): the quote still stands.
    expect((await mod.basket.saveCallBasket(call!.id, lines)).token).toBe(token)
    expect((await mod.basket.getCallBasket(call!.id))?.quote?.number).toBe('QUO-1')

    // Different lines: the quote no longer describes the basket, so it is let go,
    // the token is kept and the count of quotes saved is not reset.
    await mod.basket.saveCallBasket(call!.id, [...lines, { productId: 'p3', quantity: 4 }])
    const changed = await mod.basket.getCallBasket(call!.id)
    expect(changed).toMatchObject({ token, quote: null, quotesSaved: 1 })
    expect(changed?.lines).toHaveLength(3)

    expect(await mod.basket.openBasketByToken(token)).toHaveLength(3)
  })
})

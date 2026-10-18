'use client'

// "AI Call Answering" tab on the core admin settings page (settingsTabs
// manifest entry), split into sub-tabs:
//
//   Assistant - ElevenLabs key, voice, model and wording, and the button that
//               sets the assistant up on the ElevenLabs side
//   Numbers   - which of the site's Twilio numbers the assistant answers
//   Calls     - what the assistant has handled, with callbacks to make
//
// Calls also appear in the unified inbox with the same overview; this tab is
// where a callback is marked as dealt with.
import { useCallback, useEffect, useState } from 'react'
import { TabStrip } from '@/components/admin/TabStrip'
import { useTabParam } from '@/components/admin/useTabParam'
import { SettingsHeaderActions, SettingsHeaderStatus } from '@/components/admin/SettingsHeaderActions'
import { InfoTip } from '@/components/admin/InfoTip'
import type { ModuleSettingsTabProps } from '@/lib/modules/hosted-settings'
import { VoicePicker, type Voice } from './VoicePicker'

const SETTINGS_API = '/api/m/ai-call-answering/admin/settings'
const SYNC_API = '/api/m/ai-call-answering/admin/sync'
const FALLBACK_KEYS_API = '/api/m/ai-call-answering/admin/fallback-keys'
const VOICES_API = '/api/m/ai-call-answering/admin/voices'
const NUMBERS_API = '/api/m/ai-call-answering/admin/numbers'
const CALLS_API = '/api/m/ai-call-answering/admin/calls'

type Choice = { id: string; label: string }

type State = {
  enabled: boolean
  hasApiKey: boolean
  apiKeyFromEnv: boolean
  voiceId: string
  ttsModel: string
  llm: string
  language: string
  businessName: string
  greeting: string
  extraInstructions: string
  emailSignature: string
  maxCallMinutes: number
  agentId: string | null
  isSetUp: boolean
  needsSetup: boolean
  syncedAt: string | null
  webhookUrl: string
  ttsModels: Choice[]
  llms: Choice[]
  languages: Choice[]
  maxCallMinutesLimit: number
  fallbackKeys: Array<{ id: string; label: string; isSetUp: boolean; needsSetup: boolean }>
  maxFallbackKeys: number
}

type Draft = {
  apiKey: string
  voiceId: string
  ttsModel: string
  llm: string
  language: string
  businessName: string
  greeting: string
  extraInstructions: string
  emailSignature: string
  maxCallMinutes: number
}

type NumberRow = {
  phoneSid: string
  phoneNumber: string
  friendlyName: string
  enabled: boolean
  mode: 'always' | 'when_unattended'
  reachable: boolean
}

type CallRow = {
  id: string
  fromNumber: string
  status: 'in_progress' | 'completed'
  startedAt: string
  durationSeconds: number
  callbackNeeded: boolean
  handled: boolean
  callerName: string
  callerEmail: string
  overview: string
  transcript: string
}

const SUB_TABS = [
  { key: 'assistant', label: 'Assistant' },
  { key: 'numbers', label: 'Phone numbers' },
  { key: 'calls', label: 'Calls' },
] as const
type SubTab = (typeof SUB_TABS)[number]['key']

function draftOf(state: State): Draft {
  return {
    // Never seeded from the server: the key is not sent back, and an empty box
    // means "leave whatever is saved alone".
    apiKey: '',
    voiceId: state.voiceId,
    ttsModel: state.ttsModel,
    llm: state.llm,
    language: state.language,
    businessName: state.businessName,
    greeting: state.greeting,
    extraInstructions: state.extraInstructions,
    emailSignature: state.emailSignature,
    maxCallMinutes: state.maxCallMinutes,
  }
}

async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null) as { error?: string } | null
  return body?.error ?? fallback
}

function AssistantSection() {
  const [saved, setSaved] = useState<State | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [voices, setVoices] = useState<Voice[]>([])
  const [voiceNote, setVoiceNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [fallbackLabel, setFallbackLabel] = useState('')
  const [fallbackKey, setFallbackKey] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(SETTINGS_API)
      if (!res.ok) return
      const state = await res.json() as State
      setSaved(state)
      setDraft(draftOf(state))
    } catch { /* retried on next open */ }
  }, [])

  const loadVoices = useCallback(async () => {
    try {
      const res = await fetch(VOICES_API)
      if (!res.ok) return
      const body = await res.json() as { voices: Voice[]; note: string | null }
      setVoices(body.voices)
      setVoiceNote(body.note ?? '')
    } catch { /* the box still takes an id */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (cancelled) return
      await load()
      if (!cancelled) await loadVoices()
    })()
    return () => { cancelled = true }
  }, [load, loadVoices])

  const patch = useCallback(async (body: Record<string, unknown>): Promise<boolean> => {
    const res = await fetch(SETTINGS_API, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      setErr(await readError(res, 'Could not save those settings.'))
      return false
    }
    const state = await res.json() as State
    setSaved(state)
    setDraft(draftOf(state))
    return true
  }, [])

  const run = useCallback(async (work: () => Promise<string | null>) => {
    setBusy(true)
    setMsg('')
    setErr('')
    try {
      const done = await work()
      if (done) setMsg(done)
    } catch {
      setErr('Could not reach the site.')
    } finally {
      setBusy(false)
    }
  }, [])

  if (!saved || !draft) return <p className="field-hint">Loading…</p>

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft({ ...draft, [key]: value })

  const draftBody = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      voiceId: draft.voiceId,
      ttsModel: draft.ttsModel,
      llm: draft.llm,
      language: draft.language,
      businessName: draft.businessName,
      greeting: draft.greeting,
      extraInstructions: draft.extraInstructions,
      emailSignature: draft.emailSignature,
      maxCallMinutes: draft.maxCallMinutes,
    }
    if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim()
    return body
  }

  const save = () => run(async () => {
    if (!(await patch(draftBody()))) return null
    void loadVoices()
    return 'Saved.'
  })

  const setUp = () => run(async () => {
    if (!(await patch(draftBody()))) return null
    const res = await fetch(SYNC_API, { method: 'POST' })
    if (!res.ok) {
      setErr(await readError(res, 'Setting the assistant up failed.'))
      return null
    }
    const result = await res.json().catch(() => null) as { fallbackFailures?: Array<{ label: string; message: string }> } | null
    await load()
    const failures = result?.fallbackFailures ?? []
    if (failures.length > 0) {
      setErr(`The main assistant is set up, but ${failures.map((f) => `${f.label}: ${f.message}`).join(' ')}`)
      return null
    }
    return 'The assistant is set up with these settings.'
  })

  const addFallback = () => run(async () => {
    const res = await fetch(FALLBACK_KEYS_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: fallbackLabel, apiKey: fallbackKey }),
    })
    if (!res.ok) {
      setErr(await readError(res, 'Could not add that key.'))
      return null
    }
    setFallbackLabel('')
    setFallbackKey('')
    await load()
    return 'Key added. Press Update the assistant to get it ready.'
  })

  const removeFallback = (id: string) => run(async () => {
    const res = await fetch(FALLBACK_KEYS_API, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!res.ok) {
      setErr(await readError(res, 'Could not remove that key.'))
      return null
    }
    await load()
    return 'Key removed.'
  })

  const toggle = (enabled: boolean) => run(async () => {
    if (!(await patch({ enabled }))) return null
    return enabled ? 'The assistant is switched on.' : 'The assistant is switched off. Calls go to forwarding and voicemail.'
  })

  let status = 'Not set up yet'
  if (saved.isSetUp) status = saved.needsSetup ? 'Set up, but your settings have changed since' : 'Set up and up to date'

  return (
    <div>
      <SettingsHeaderActions>
        <SettingsHeaderStatus message={msg} error={err} />
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Working…' : 'Save changes'}
        </button>
      </SettingsHeaderActions>

      <div className="settings-cols">
        <div className="card">
          <div className="card-title">
            Answering calls
            <InfoTip>
              Callers to the numbers you choose are connected to an ElevenLabs voice assistant. It can talk about your
              products, suggest things from the shop, check on an order once the caller has given the delivery postcode
              and an order number, email or company name, and take a name and email for anything it cannot help with.
              If anything goes wrong, the call falls back to your usual forwarding and voicemail.
            </InfoTip>
          </div>
          <p className="field-hint"><strong>{status}.</strong>{saved.syncedAt ? ` Last set up ${new Date(saved.syncedAt).toLocaleString()}.` : ''}</p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <button type="button" className="btn btn-primary" onClick={setUp} disabled={busy || (!saved.hasApiKey && !draft.apiKey.trim())}>
              {saved.isSetUp ? 'Update the assistant' : 'Set up the assistant'}
            </button>
            {saved.isSetUp && (
              <button type="button" className={saved.enabled ? 'btn btn-secondary' : 'btn btn-primary'} onClick={() => toggle(!saved.enabled)} disabled={busy}>
                {saved.enabled ? 'Switch off' : 'Switch on'}
              </button>
            )}
          </div>
          <p className="field-hint">
            {saved.enabled
              ? 'The assistant is ON. It answers the numbers ticked under Phone numbers.'
              : 'The assistant is OFF. Nothing changes for your callers until it is switched on and a number is ticked.'}
          </p>
          <p className="field-hint">
            Setting it up saves the settings on this page and then creates or updates the assistant at ElevenLabs. Run it
            again after changing the voice, the wording or the shop name.
          </p>
        </div>

        <div className="card">
          <div className="card-title">ElevenLabs</div>
          {saved.apiKeyFromEnv ? (
            <div className="alert alert-info">
              The key is set on this site&rsquo;s hosting (<code>ELEVENLABS_API_KEY</code>), so there is nothing to type in.
            </div>
          ) : (
            <div className="field">
              <label>ElevenLabs API key</label>
              <input
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                placeholder={saved.hasApiKey ? 'A key is saved. Type a new one to replace it.' : 'Paste your key here'}
                onChange={(e) => set('apiKey', e.target.value)}
              />
              <p className="field-hint">
                From <strong>elevenlabs.io</strong>, under Developers, API Keys. It needs access to Agents (read and write),
                Voices (read) and Workspace webhooks. It is stored encrypted and never shown again.
                {saved.hasApiKey && (
                  <>
                    {' '}
                    <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={() => { void run(async () => (await patch({ clearApiKey: true })) ? 'Key removed.' : null) }}>
                      Remove the saved key
                    </button>
                  </>
                )}
              </p>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-title">
            Fallback ElevenLabs keys
            <InfoTip>
              ElevenLabs credit is used up per account. If the main key is refused (out of credit, over its limit or no
              longer valid), each call is offered to these keys in turn, in the order listed. Each key should belong to
              a different ElevenLabs account, and each gets its own assistant made by Set up the assistant.
            </InfoTip>
          </div>
          {saved.fallbackKeys.length === 0 ? (
            <p className="field-hint">None yet. The assistant uses the main key only.</p>
          ) : (
            <ol style={{ paddingLeft: '1.25rem', margin: '0 0 0.75rem' }}>
              {saved.fallbackKeys.map((key, index) => (
                <li key={key.id} style={{ marginBottom: '0.35rem' }}>
                  <strong>{key.label || `Fallback key ${index + 1}`}</strong>
                  {' - '}
                  {!key.isSetUp ? 'not set up yet' : key.needsSetup ? 'set up, but settings have changed since' : 'ready'}
                  {' '}
                  <button type="button" className="btn btn-link btn-sm" disabled={busy} onClick={() => { void removeFallback(key.id) }}>
                    Remove
                  </button>
                </li>
              ))}
            </ol>
          )}
          {saved.fallbackKeys.length < saved.maxFallbackKeys && (
            <>
              <div className="field">
                <label>Name (so you can tell them apart)</label>
                <input type="text" value={fallbackLabel} maxLength={60} placeholder="e.g. Second account" onChange={(e) => setFallbackLabel(e.target.value)} />
              </div>
              <div className="field">
                <label>Fallback API key</label>
                <input type="password" autoComplete="off" value={fallbackKey} placeholder="Paste the key here" onChange={(e) => setFallbackKey(e.target.value)} />
                <p className="field-hint">
                  Same permissions as the main key. It is stored encrypted and never shown again. The voice chosen below
                  has to exist on that account too; a voice from the shared library must be added to it first.
                </p>
              </div>
              <button type="button" className="btn btn-secondary" onClick={addFallback} disabled={busy || !fallbackKey.trim() || !saved.hasApiKey}>
                Add fallback key
              </button>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-title">Voice and brain</div>
          <div className="field">
            <label>Voice</label>
            <VoicePicker
              voiceId={draft.voiceId}
              voices={voices}
              note={voiceNote}
              onSelect={(id) => set('voiceId', id)}
              onAccountChanged={loadVoices}
            />
          </div>
          <div className="field">
            <label>Speech model</label>
            <select value={draft.ttsModel} style={{ maxWidth: '30rem' }} onChange={(e) => set('ttsModel', e.target.value)}>
              {saved.ttsModels.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
            <p className="field-hint">The model that turns the assistant&rsquo;s words into speech. The newest is the most lifelike.</p>
          </div>
          <div className="field">
            <label>Thinking model</label>
            <select value={draft.llm} style={{ maxWidth: '30rem' }} onChange={(e) => set('llm', e.target.value)}>
              {saved.llms.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
            <p className="field-hint">Works out what to say and which lookups to make. Quicker models answer sooner, careful ones slip up less.</p>
          </div>
          <div className="field">
            <label>Language</label>
            <select value={draft.language} style={{ maxWidth: '12rem' }} onChange={(e) => set('language', e.target.value)}>
              {saved.languages.map((language) => <option key={language.id} value={language.id}>{language.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Longest call (minutes)</label>
            <input type="number" min={1} max={saved.maxCallMinutesLimit} value={draft.maxCallMinutes} style={{ maxWidth: '8rem' }}
              onChange={(e) => set('maxCallMinutes', Math.min(Math.max(Number(e.target.value) || 1, 1), saved.maxCallMinutesLimit))} />
            <p className="field-hint">The assistant ends a call that runs past this. ElevenLabs charges by the minute.</p>
          </div>
        </div>

        <div className="card">
          <div className="card-title">What it says</div>
          <div className="field">
            <label>Business name</label>
            <input type="text" value={draft.businessName} onChange={(e) => set('businessName', e.target.value)} />
            <p className="field-hint">How the assistant refers to you, for example &ldquo;Deskwell&rdquo;.</p>
          </div>
          <div className="field">
            <label>Greeting</label>
            <textarea rows={2} value={draft.greeting} onChange={(e) => set('greeting', e.target.value)} />
            <p className="field-hint">The first thing callers hear. Leave empty for a standard greeting using your business name.</p>
          </div>
          <div className="field">
            <label>Extra instructions</label>
            <textarea rows={6} value={draft.extraInstructions} onChange={(e) => set('extraInstructions', e.target.value)} />
            <p className="field-hint">
              Anything particular to your business: opening hours, how you handle returns, what never to promise. These are
              added to the built-in rules, which already cover checking who is calling before discussing an order and
              taking a name and email when it cannot help.
            </p>
          </div>
        </div>

        <div className="card">
          <div className="card-title">Emails to callers</div>
          <p className="field-hint">
            The assistant offers to email callers a written note of what you discussed: the advice, and links to any
            products it mentioned. Choose the address those emails come from, and the inbox a copy is filed in, in the
            &ldquo;Sending address&rdquo; box below. Replies then land in that inbox.
          </p>
          <div className="field">
            <label>Email signature</label>
            <textarea rows={5} value={draft.emailSignature} onChange={(e) => set('emailSignature', e.target.value)} />
            <p className="field-hint">
              Added to the end of every email the assistant sends, for example a name, job title and phone number. Plain
              text (new lines are kept) or pasted HTML. Leave empty for no signature.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function NumbersSection() {
  const [rows, setRows] = useState<NumberRow[] | null>(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(NUMBERS_API)
      if (!res.ok) return
      setRows((await res.json() as { numbers: NumberRow[] }).numbers)
    } catch { /* retried on next open */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (!cancelled) await load()
    })()
    return () => { cancelled = true }
  }, [load])

  const save = async (row: NumberRow, change: Partial<Pick<NumberRow, 'enabled' | 'mode'>>) => {
    setBusy(row.phoneSid)
    setErr('')
    try {
      const res = await fetch(NUMBERS_API, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phoneSid: row.phoneSid, enabled: change.enabled ?? row.enabled, mode: change.mode ?? row.mode }),
      })
      if (!res.ok) setErr(await readError(res, 'Could not save that.'))
      else setRows((await res.json() as { numbers: NumberRow[] }).numbers)
    } catch {
      setErr('Could not reach the site.')
    } finally {
      setBusy('')
    }
  }

  if (!rows) return <p className="field-hint">Loading…</p>

  return (
    <div className="settings-cols">
      <div className="card">
        <div className="card-title">
          Phone numbers
          <InfoTip>
            The numbers come from the Twilio tab. A number can only be answered by the assistant if it has call handling
            switched on there (forwarding or voicemail), because that is what points the number at this site.
          </InfoTip>
        </div>
        {err && <div className="alert alert-error">{err}</div>}
        {rows.length === 0 && <p className="field-hint">No numbers have been added to the site yet. Add them in the Twilio tab first.</p>}
        {rows.map((row) => (
          <div key={row.phoneSid} className="field" style={{ borderTop: '1px solid var(--color-border)', paddingTop: '0.75rem' }}>
            <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input type="checkbox" checked={row.enabled} disabled={busy === row.phoneSid} onChange={(e) => { void save(row, { enabled: e.target.checked }) }} />
              <strong>{row.friendlyName && row.friendlyName !== row.phoneNumber ? `${row.friendlyName} (${row.phoneNumber})` : row.phoneNumber}</strong>
            </label>
            {row.enabled && (
              <select value={row.mode} disabled={busy === row.phoneSid} style={{ maxWidth: '26rem' }} onChange={(e) => { void save(row, { mode: e.target.value as NumberRow['mode'] }) }}>
                <option value="always">Answer every call</option>
                <option value="when_unattended">Only when the number is shut, nothing would ring, or nobody answers</option>
              </select>
            )}
            {row.enabled && !row.reachable && (
              <p className="field-hint" style={{ color: 'var(--color-danger)' }}>
                This number has no call handling in the Twilio tab, so calls never reach this site. Switch on forwarding or
                voicemail for it there.
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function CallsSection() {
  const [calls, setCalls] = useState<CallRow[] | null>(null)
  const [open, setOpen] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch(CALLS_API)
      if (!res.ok) return
      setCalls((await res.json() as { calls: CallRow[] }).calls)
    } catch { /* retried on next open */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      await Promise.resolve()
      if (cancelled) return
      const wanted = new URLSearchParams(window.location.search).get('call')
      if (wanted) setOpen(wanted)
      await load()
    })()
    return () => { cancelled = true }
  }, [load])

  const patch = async (id: string, body: Record<string, unknown>) => {
    setErr('')
    try {
      const res = await fetch(CALLS_API, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, ...body }) })
      if (!res.ok) setErr(await readError(res, 'Could not save that.'))
      await load()
    } catch {
      setErr('Could not reach the site.')
    }
  }

  if (!calls) return <p className="field-hint">Loading…</p>

  const waiting = calls.filter((call) => call.callbackNeeded && !call.handled).length

  return (
    <div className="settings-cols">
      <div className="card">
        <div className="card-title">
          Calls the assistant took
          <InfoTip>The same overviews appear in the unified inbox. Callbacks stay flagged until you mark them as dealt with.</InfoTip>
        </div>
        {err && <div className="alert alert-error">{err}</div>}
        {waiting > 0 && <div className="alert alert-info"><strong>{waiting}</strong> caller{waiting === 1 ? ' is' : 's are'} waiting to be contacted.</div>}
        {calls.length === 0 && <p className="field-hint">No calls yet.</p>}
        {calls.map((call) => {
          const expanded = open === call.id
          return (
            <div key={call.id} style={{ borderTop: '1px solid var(--color-border)', padding: '0.75rem 0' }}>
              <button type="button" className="btn btn-link" style={{ textAlign: 'left', padding: 0 }} onClick={() => setOpen(expanded ? '' : call.id)}>
                <strong>{call.callerName || (call.fromNumber.startsWith('+') ? call.fromNumber : 'Withheld number')}</strong>
                {' - '}{new Date(call.startedAt).toLocaleString()}
                {call.status === 'in_progress' ? ' - in progress' : ''}
                {call.callbackNeeded ? (call.handled ? ' - callback done' : ' - CALLBACK NEEDED') : ''}
              </button>
              {expanded && (
                <div style={{ marginTop: '0.5rem' }}>
                  <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}>{call.overview}</pre>
                  {call.callbackNeeded && (
                    <p>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => { void patch(call.id, { handled: !call.handled }) }}>
                        {call.handled ? 'Mark as not dealt with' : 'Mark as dealt with'}
                      </button>
                      {call.callerEmail && <> {' '}<a className="btn btn-link btn-sm" href={`mailto:${call.callerEmail}`}>Email {call.callerEmail}</a></>}
                    </p>
                  )}
                  <details>
                    <summary>Transcript</summary>
                    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{call.transcript}</pre>
                  </details>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// A panel another module may publish at the foot of the Assistant tab. The
// unified inbox uses it to ask which address the order links go out from. An
// empty slot renders nothing - no heading, no gap.
const HOSTED_EMAIL_SLOT = 'ai-call-answering.settings-emails'

export function AiCallAnsweringSettingsTab({ hostedSettingsSlots }: ModuleSettingsTabProps = {}) {
  const [sub, setSub] = useTabParam<SubTab>('sub', 'assistant', SUB_TABS.map((t) => t.key))
  return (
    <div>
      <TabStrip
        items={SUB_TABS.map((t) => ({ key: t.key, label: t.label, active: t.key === sub, onClick: () => setSub(t.key) }))}
      />
      {sub === 'assistant' && <AssistantSection />}
      {sub === 'assistant' && hostedSettingsSlots?.[HOSTED_EMAIL_SLOT]}
      {sub === 'numbers' && <NumbersSection />}
      {sub === 'calls' && <CallsSection />}
    </div>
  )
}

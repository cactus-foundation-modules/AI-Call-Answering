'use client'

// The voice chooser on the Assistant tab. Two sources, one set of filters:
//
//   My voices      - what is already on the ElevenLabs account
//   Voice library  - ElevenLabs' shared library (Cass, Cruella, Daria and
//                    thousands more). A library voice is added to the account
//                    the moment it is chosen, because an agent can only speak
//                    with a voice the account holds.
//
// Accent, gender and age narrow either list; the accent starts on British.
import { useCallback, useMemo, useState } from 'react'

const VOICES_API = '/api/m/ai-call-answering/admin/voices'

export type Voice = {
  id: string
  name: string
  description: string
  accent: string
  gender: string
  age: string
  previewUrl: string | null
  publicOwnerId?: string
}

const ACCENTS = ['british', 'american', 'australian', 'irish', 'scottish', 'welsh', 'indian', 'south african', 'canadian', 'new zealand']
const GENDERS = ['female', 'male', 'neutral']
const AGES = ['young', 'middle_aged', 'old']

function title(value: string): string {
  return value.replace(/_/g, ' ').replace(/(^|\s)\S/g, (m) => m.toUpperCase())
}

type Props = {
  voiceId: string
  voices: Voice[]
  note: string
  onSelect: (id: string) => void
  onAccountChanged: () => Promise<void>
}

export function VoicePicker({ voiceId, voices, note, onSelect, onAccountChanged }: Props) {
  const [source, setSource] = useState<'account' | 'library'>('account')
  const [search, setSearch] = useState('')
  const [accent, setAccent] = useState('british')
  const [gender, setGender] = useState('')
  const [age, setAge] = useState('')
  const [library, setLibrary] = useState<Voice[]>([])
  const [page, setPage] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [searched, setSearched] = useState(false)
  const [loading, setLoading] = useState(false)
  const [libraryNote, setLibraryNote] = useState('')
  const [adding, setAdding] = useState('')
  const [addError, setAddError] = useState('')

  const filteredAccount = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return voices.filter((voice) =>
      (!accent || voice.accent === accent)
      && (!gender || voice.gender === gender)
      && (!age || voice.age === age)
      && (!needle || voice.name.toLowerCase().includes(needle) || voice.description.toLowerCase().includes(needle)),
    )
  }, [voices, search, accent, gender, age])

  const searchLibrary = useCallback(async (nextPage: number) => {
    setLoading(true)
    setLibraryNote('')
    try {
      const query = new URLSearchParams({ source: 'library', search, accent, gender, age, page: String(nextPage) })
      const res = await fetch(`${VOICES_API}?${query.toString()}`)
      if (!res.ok) {
        setLibraryNote('Could not search the voice library.')
        return
      }
      const body = await res.json() as { voices: Voice[]; hasMore: boolean; note: string | null }
      setLibrary((current) => (nextPage === 0 ? body.voices : [...current, ...body.voices]))
      setHasMore(body.hasMore)
      setPage(nextPage)
      setSearched(true)
      setLibraryNote(body.note ?? '')
    } catch {
      setLibraryNote('Could not reach the site.')
    } finally {
      setLoading(false)
    }
  }, [search, accent, gender, age])

  const addAndUseVoice = async (voice: Voice) => {
    setAdding(voice.id)
    setAddError('')
    try {
      const res = await fetch(VOICES_API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicOwnerId: voice.publicOwnerId, voiceId: voice.id, name: voice.name }),
      })
      const body = await res.json().catch(() => null) as { id?: string; error?: string } | null
      if (!res.ok || !body?.id) {
        setAddError(body?.error ?? 'ElevenLabs would not add that voice. Adding library voices needs a paid ElevenLabs plan.')
        return
      }
      await onAccountChanged()
      onSelect(body.id)
    } catch {
      setAddError('Could not reach the site.')
    } finally {
      setAdding('')
    }
  }

  const chosen = voices.find((voice) => voice.id === voiceId)
  const shown = source === 'account' ? filteredAccount : library

  return (
    <div>
      {chosen && (
        <p className="field-hint" style={{ marginTop: 0 }}>
          Current voice: <strong>{chosen.name}</strong>{chosen.description ? ` (${chosen.description})` : ''}
        </p>
      )}
      {!chosen && voiceId && <p className="field-hint" style={{ marginTop: 0 }}>Current voice id: {voiceId}</p>}

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <button type="button" className={source === 'account' ? 'btn btn-primary' : 'btn'} onClick={() => setSource('account')}>
          My voices
        </button>
        <button type="button" className={source === 'library' ? 'btn btn-primary' : 'btn'} onClick={() => setSource('library')}>
          Voice library
        </button>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <input
          type="search"
          placeholder={source === 'library' ? 'Search by name, e.g. Cass' : 'Filter by name'}
          value={search}
          style={{ maxWidth: '16rem' }}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && source === 'library') {
              e.preventDefault()
              void searchLibrary(0)
            }
          }}
        />
        <select value={accent} aria-label="Accent" onChange={(e) => setAccent(e.target.value)}>
          <option value="">Any accent</option>
          {ACCENTS.map((value) => <option key={value} value={value}>{title(value)}</option>)}
        </select>
        <select value={gender} aria-label="Gender" onChange={(e) => setGender(e.target.value)}>
          <option value="">Any gender</option>
          {GENDERS.map((value) => <option key={value} value={value}>{title(value)}</option>)}
        </select>
        <select value={age} aria-label="Age" onChange={(e) => setAge(e.target.value)}>
          <option value="">Any age</option>
          {AGES.map((value) => <option key={value} value={value}>{title(value)}</option>)}
        </select>
        {source === 'library' && (
          <button type="button" className="btn" onClick={() => void searchLibrary(0)} disabled={loading}>
            {loading && page === 0 ? 'Searching…' : 'Search'}
          </button>
        )}
      </div>

      {source === 'library' && !searched && !loading && (
        <p className="field-hint">Press Search to browse the library with these filters. Browsing shows conversational voices; searching by name shows any.</p>
      )}
      {shown.length === 0 && (source === 'account' || searched) && (
        <p className="field-hint">No voices match those filters.</p>
      )}

      <div style={{ display: 'grid', gap: '0.5rem', maxHeight: '26rem', overflowY: 'auto' }}>
        {shown.map((voice) => {
          const selected = voice.id === voiceId
          return (
            <div
              key={`${source}-${voice.id}`}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.75rem',
                padding: '0.5rem 0.75rem',
                border: selected ? '2px solid var(--color-primary)' : '1px solid var(--color-border)',
                borderRadius: '0.5rem',
              }}
            >
              <div style={{ flex: '1 1 14rem', minWidth: 0 }}>
                <strong>{voice.name}</strong>
                {voice.description && <div className="field-hint" style={{ margin: 0 }}>{voice.description}</div>}
              </div>
              {voice.previewUrl && (
                <audio controls preload="none" src={voice.previewUrl} style={{ height: '2rem', maxWidth: '14rem' }} />
              )}
              {source === 'account' ? (
                <button type="button" className="btn" disabled={selected} onClick={() => onSelect(voice.id)}>
                  {selected ? 'Selected' : 'Use this voice'}
                </button>
              ) : (
                <button type="button" className="btn" disabled={adding !== ''} onClick={() => void addAndUseVoice(voice)}>
                  {adding === voice.id ? 'Adding…' : 'Add and use'}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {source === 'library' && hasMore && (
        <button type="button" className="btn" style={{ marginTop: '0.5rem' }} disabled={loading} onClick={() => void searchLibrary(page + 1)}>
          {loading ? 'Loading…' : 'Show more'}
        </button>
      )}
      {addError && <p className="field-hint" role="alert">{addError}</p>}
      {libraryNote && <p className="field-hint">{libraryNote}</p>}
      {note && <p className="field-hint">{note}</p>}
      <p className="field-hint">
        Choosing a voice only changes the draft: press Save, then set the assistant up again, for it to take effect.
      </p>
    </div>
  )
}

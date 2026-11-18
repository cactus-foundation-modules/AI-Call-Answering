'use client'

// The GPT-Live voice chooser on the Assistant tab: every built-in voice,
// grouped (British and Irish first), each with a Play button, plus a box for
// the id of a custom voice made in the OpenAI project.
//
// OpenAI publishes no sample clips, so Play asks the site to have GPT-Live say
// a line in that voice (admin/live-voice-preview). The first play of a voice
// takes a few seconds; after that it is instant, from the site's memory and
// then from this page's.
import { useEffect, useMemo, useRef, useState } from 'react'

const PREVIEW_API = '/api/m/ai-call-answering/admin/live-voice-preview'

export type LiveVoice = { id: string; label: string; group: string; description: string }

type Props = {
  value: string
  voices: LiveVoice[]
  /** A key is saved, so samples can be made. A key only typed into the draft
   *  is not usable until Save. */
  canPreview: boolean
  onSelect: (id: string) => void
}

export function LiveVoicePicker({ value, voices, canPreview, onSelect }: Props) {
  const [loading, setLoading] = useState('')
  const [playing, setPlaying] = useState('')
  const [error, setError] = useState('')
  const urls = useRef(new Map<string, string>())
  const player = useRef<HTMLAudioElement | null>(null)

  const groups = useMemo(() => {
    const byGroup = new Map<string, LiveVoice[]>()
    for (const voice of voices) byGroup.set(voice.group, [...(byGroup.get(voice.group) ?? []), voice])
    return [...byGroup.entries()]
  }, [voices])

  const isCustom = value !== '' && !voices.some((voice) => voice.id === value)
  const [customId, setCustomId] = useState(isCustom ? value : '')

  useEffect(() => {
    const made = urls.current
    return () => {
      player.current?.pause()
      for (const url of made.values()) URL.revokeObjectURL(url)
    }
  }, [])

  async function play(id: string) {
    setError('')
    player.current?.pause()
    if (playing === id) {
      setPlaying('')
      return
    }
    let url = urls.current.get(id)
    if (!url) {
      setLoading(id)
      try {
        const res = await fetch(`${PREVIEW_API}?voice=${encodeURIComponent(id)}`)
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: string } | null
          setError(body?.error ?? 'Could not play that voice.')
          return
        }
        url = URL.createObjectURL(await res.blob())
        urls.current.set(id, url)
      } catch {
        setError('Could not reach the site to make a sample.')
        return
      } finally {
        setLoading('')
      }
    }
    const audio = new Audio(url)
    player.current = audio
    audio.addEventListener('ended', () => setPlaying((current) => (current === id ? '' : current)))
    setPlaying(id)
    await audio.play().catch(() => {
      setPlaying('')
      setError('Your browser would not play the sample.')
    })
  }

  function playLabel(id: string): string {
    if (loading === id) return 'Making sample…'
    return playing === id ? 'Stop' : 'Play'
  }

  return (
    <div>
      {!canPreview && (
        <p className="field-hint" style={{ marginTop: 0 }}>Save your OpenAI API key to hear each voice.</p>
      )}
      <div style={{ display: 'grid', gap: '0.75rem', maxHeight: '30rem', overflowY: 'auto' }}>
        {groups.map(([group, members]) => (
          <div key={group}>
            <div className="field-hint" style={{ margin: '0 0 0.25rem', fontWeight: 600 }}>{group}</div>
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {members.map((voice) => {
                const selected = voice.id === value
                return (
                  <div
                    key={voice.id}
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
                    <div style={{ flex: '1 1 12rem', minWidth: 0 }}>
                      <strong>{voice.label}</strong>
                      {voice.description && <div className="field-hint" style={{ margin: 0 }}>{voice.description}</div>}
                    </div>
                    <button
                      type="button"
                      className="btn"
                      disabled={!canPreview || (loading !== '' && loading !== voice.id)}
                      aria-label={`${playLabel(voice.id)} ${voice.label}`}
                      onClick={() => void play(voice.id)}
                    >
                      {playLabel(voice.id)}
                    </button>
                    <button type="button" className="btn" disabled={selected} onClick={() => onSelect(voice.id)}>
                      {selected ? 'Selected' : 'Use this voice'}
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginTop: '0.75rem' }}>
        <input
          type="text"
          aria-label="Custom voice id"
          placeholder="Or a custom voice id from your OpenAI project"
          value={customId}
          style={{ maxWidth: '22rem' }}
          onChange={(e) => setCustomId(e.target.value.trim())}
        />
        <button type="button" className="btn" disabled={!customId || !canPreview || loading !== ''} onClick={() => void play(customId)}>
          {customId ? playLabel(customId) : 'Play'}
        </button>
        <button type="button" className="btn" disabled={!customId || customId === value} onClick={() => onSelect(customId)}>
          {customId && customId === value ? 'Selected' : 'Use this voice'}
        </button>
      </div>

      {error && <p className="field-hint" role="alert">{error}</p>}
      <p className="field-hint">
        Samples are spoken by GPT-Live itself, so the first play of each voice takes a few seconds, billed as a few seconds of GPT-Live.
        Choosing a voice changes the draft: press Save for the next call to use it.
      </p>
    </div>
  )
}

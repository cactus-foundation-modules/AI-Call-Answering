import { LIVE_MODEL } from './settings'

// ---------------------------------------------------------------------------
// A short spoken sample of a GPT-Live voice, for the voice picker.
//
// OpenAI publishes no sample clips for its Live voices, and its text-to-speech
// endpoint knows only 13 of the 38, so the only faithful sample is GPT-Live
// itself: open a session in that voice over the primary WebSocket, ask it to
// say one line, keep the audio it sends back and wrap it as a WAV.
//
// Each sample is a few seconds of a billed session, so samples are kept in
// memory for the life of the process (the site runs as one long-lived Node
// process) and a sample being made is shared by anybody who asks for it at the
// same moment.
//
// SERVER ONLY. It holds the OpenAI key.
// ---------------------------------------------------------------------------

const LIVE_SOCKET_URL = 'wss://api.openai.com/v1/live/sessions'
/** Mono signed 16-bit little-endian PCM at 24 kHz, GPT-Live's default. */
export const PREVIEW_SAMPLE_RATE = 24_000
/** The longest a sample may take to make, start to finish. */
const PREVIEW_TIMEOUT_MS = 25_000
/** Once speech has started, this much quiet means the line is finished. GPT-Live
 *  sends no "audio done" event on the primary socket. */
const QUIET_AFTER_SPEECH_MS = 1_500
/** GPT-Live only talks while it is being sent audio, as on a real call, so the
 *  sample session is sent silence in 100 ms chunks for as long as it is open. */
const SILENCE_CHUNK_MS = 100
const SILENCE = Buffer.alloc((PREVIEW_SAMPLE_RATE / 1000) * SILENCE_CHUNK_MS * 2).toString('base64')
/** Room for every built-in voice at two different business names. */
const MAX_CACHED = 80

/** Node's built-in WebSocket takes headers as a second argument; the DOM type
 *  this project compiles against does not know that. */
type NodeWebSocketConstructor = new (url: string, init: { headers: Record<string, string> }) => WebSocket

export class VoicePreviewError extends Error {}

/** What each voice says: the start of a real call, so a voice is judged on the
 *  job it will do. */
export function previewLine(businessName: string): string {
  const name = businessName.trim() || 'the shop'
  return `Hello, you're through to ${name}. I'm the digital assistant, so ask me anything about our products, delivery or an order.`
}

/** Wraps raw PCM16 mono in the 44-byte RIFF header every browser plays. Pure. */
export function pcmToWav(pcm: Buffer, sampleRate: number = PREVIEW_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // bytes per second
  header.writeUInt16LE(2, 32) // bytes per frame
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function sayLine(line: string): string {
  return `Immediately say the following exactly and in full, then stop and stay silent: ${line}`
}

/** The first message on the socket: the voice, the format, instructions that
 *  keep the model to the one line, and the line itself as a developer message
 *  (OpenAI's recipe for making the model speak first). No backend: nothing is
 *  looked up. */
export function previewStartEvent(voice: string, line: string): Record<string, unknown> {
  return {
    type: 'session.start',
    event_id: 'preview_start',
    session: {
      model: LIVE_MODEL,
      instructions: 'You are recording a short voice sample for a shop choosing a telephone voice. When asked, say the line you are given, word for word, in a warm and natural telephone manner. Add nothing before or after it, then stay silent.',
      audio: {
        format: { type: 'audio/pcm', rate: PREVIEW_SAMPLE_RATE },
        output: { voice },
      },
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: sayLine(line) }] },
      ],
    },
  }
}

/** Sent once the session has started. Instructions rather than commentary:
 *  OpenAI says commentary may be paraphrased, instructions ask for the exact
 *  words. */
export function previewSpeakEvent(line: string): Record<string, unknown> {
  return {
    type: 'session.instructions.append',
    event_id: 'preview_line',
    delegation_id: null,
    content: sayLine(line),
  }
}

type SocketEvent = { type?: unknown; delta?: unknown; error?: { message?: unknown; code?: unknown } }

/** Makes one sample. Resolves with WAV bytes; rejects with a VoicePreviewError
 *  whose message is fit to show the shop. */
export function makeVoicePreview(apiKey: string, voice: string, line: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const Ws = WebSocket as unknown as NodeWebSocketConstructor
    const ws = new Ws(LIVE_SOCKET_URL, { headers: { Authorization: `Bearer ${apiKey}` } })
    const chunks: Buffer[] = []
    let settled = false
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    let silence: ReturnType<typeof setInterval> | undefined

    const finish = (error: VoicePreviewError | null) => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      clearTimeout(quietTimer)
      clearInterval(silence)
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.close' }))
      } catch {
        // Closing anyway.
      }
      // A moment for session.close to reach OpenAI so billing stops there.
      setTimeout(() => {
        try { ws.close() } catch { /* already closed */ }
      }, 500)
      const pcm = Buffer.concat(chunks)
      if (error) reject(error)
      else if (pcm.length === 0) reject(new VoicePreviewError('OpenAI sent no audio for that voice.'))
      else resolve(pcmToWav(pcm.subarray(0, pcm.length - (pcm.length % 2))))
    }

    const overall = setTimeout(() => {
      // A slow sample that did start is still worth hearing.
      finish(chunks.length > 0 ? null : new VoicePreviewError('OpenAI took too long to make the sample. Try again in a moment.'))
    }, PREVIEW_TIMEOUT_MS)

    ws.addEventListener('open', () => ws.send(JSON.stringify(previewStartEvent(voice, line))))
    ws.addEventListener('message', (message) => {
      let event: SocketEvent
      try {
        event = JSON.parse(typeof message.data === 'string' ? message.data : String(message.data)) as SocketEvent
      } catch {
        return
      }
      switch (event.type) {
        case 'session.started':
          ws.send(JSON.stringify(previewSpeakEvent(line)))
          silence = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'session.input_audio.append', audio: SILENCE }))
          }, SILENCE_CHUNK_MS)
          return
        case 'session.output_audio.delta':
          if (typeof event.delta === 'string') chunks.push(Buffer.from(event.delta, 'base64'))
          clearTimeout(quietTimer)
          quietTimer = setTimeout(() => finish(null), QUIET_AFTER_SPEECH_MS)
          return
        case 'error': {
          const detail = typeof event.error?.message === 'string' ? event.error.message : 'unknown error'
          console.error(`[ai-call-answering] voice preview for ${voice} failed: ${detail}`)
          finish(new VoicePreviewError(`OpenAI would not make a sample: ${detail}`))
          return
        }
        case 'session.closed':
          finish(null)
          return
        default:
      }
    })
    ws.addEventListener('error', () => finish(new VoicePreviewError('Could not reach OpenAI to make the sample.')))
    ws.addEventListener('close', () => finish(null))
  })
}

const cache = new Map<string, Buffer>()
const making = new Map<string, Promise<Buffer>>()

/** A sample for this voice and line, from memory when there is one. */
export async function getVoicePreview(apiKey: string, voice: string, line: string): Promise<Buffer> {
  const key = `${voice}\n${line}`
  const cached = cache.get(key)
  if (cached) return cached
  const pending = making.get(key)
  if (pending) return pending
  const job = makeVoicePreview(apiKey, voice, line)
    .then((wav) => {
      cache.set(key, wav)
      // Oldest out first: a Map keeps insertion order.
      while (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value
        if (oldest === undefined) break
        cache.delete(oldest)
      }
      return wav
    })
    .finally(() => making.delete(key))
  making.set(key, job)
  return job
}

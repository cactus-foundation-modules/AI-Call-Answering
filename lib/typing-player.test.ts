import { describe, expect, it } from 'vitest'
import { TypingPlayer, type TypingLeg } from './typing-player'

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('TypingPlayer', () => {
  it('removes a leg that was still being added when the stop came', async () => {
    const adding = deferred<TypingLeg>()
    const removed: string[] = []
    const player = new TypingPlayer({ start: () => adding.promise, stop: async (leg) => { removed.push(leg.callSid) }, log: () => undefined })
    player.start()
    player.stop()
    expect(removed).toEqual([])
    adding.resolve({ callSid: 'CA1', conferenceSid: 'CF1' })
    await player.idle()
    expect(removed).toEqual(['CA1'])
  })

  it('never has two legs at once: a new start waits for the last removal', async () => {
    const events: string[] = []
    const removing = deferred<void>()
    let count = 0
    const player = new TypingPlayer({
      start: async () => { count += 1; events.push(`add ${count}`); return { callSid: `CA${count}`, conferenceSid: 'CF1' } },
      stop: async (leg) => { events.push(`removing ${leg.callSid}`); await removing.promise; events.push(`removed ${leg.callSid}`) },
      log: () => undefined,
    })
    player.start()
    await player.idle()
    player.stop()
    player.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['add 1', 'removing CA1'])
    removing.resolve()
    await player.idle()
    expect(events).toEqual(['add 1', 'removing CA1', 'removed CA1', 'add 2'])
  })

  it('ignores a second start while playing, and a stop with nothing playing', async () => {
    let adds = 0
    let removes = 0
    const player = new TypingPlayer({ start: async () => { adds += 1; return { callSid: 'CA1', conferenceSid: 'CF1' } }, stop: async () => { removes += 1 }, log: () => undefined })
    player.stop()
    player.start()
    player.start()
    await player.idle()
    player.stop()
    player.stop()
    await player.idle()
    expect([adds, removes]).toEqual([1, 1])
  })

  it('a failed start costs the call nothing: logged, and the next start tries again', async () => {
    const logged: string[] = []
    let attempt = 0
    const player = new TypingPlayer({
      start: async () => { attempt += 1; if (attempt === 1) throw new Error('Twilio said no'); return { callSid: 'CA2', conferenceSid: 'CF1' } },
      stop: async () => undefined,
      log: (message) => logged.push(message),
    })
    player.start()
    await player.idle()
    player.stop()
    player.start()
    await player.idle()
    expect(logged).toEqual(['could not start the typing sound'])
    expect(attempt).toBe(2)
  })
})

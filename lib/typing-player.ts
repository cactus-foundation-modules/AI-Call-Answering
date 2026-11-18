// ---------------------------------------------------------------------------
// Turns LiveSession's "working started / stopped" into one Twilio leg that
// plays the typing loop, and makes sure there is never more than one.
//
// Starting a leg and removing it are both requests to Twilio that take a
// moment, and the session can change its mind in between (the voice speaks a
// second after the typing was asked for). So the requests are kept in order:
// a stop waits for the start it undoes, and a new start waits for the last stop
// to finish. The worst case is a leg that plays for the length of one request
// longer than it should, never two at once.
//
// The Twilio calls themselves are handed in, so a test can drive it.
// ---------------------------------------------------------------------------

export type TypingLeg = { conferenceSid: string; callSid: string }

export type TypingOps = {
  start: () => Promise<TypingLeg>
  stop: (leg: TypingLeg) => Promise<void>
  log: (message: string, detail?: unknown) => void
}

export class TypingPlayer {
  private current: Promise<TypingLeg | null> | null = null
  private settled: Promise<void> = Promise.resolve()

  constructor(private readonly ops: TypingOps) {}

  get playing(): boolean {
    return this.current !== null
  }

  start(): void {
    if (this.current) return
    this.current = this.settled
      .then(() => this.ops.start())
      .catch((error: unknown) => {
        // No typing this time; the call itself is untouched.
        this.ops.log('could not start the typing sound', error)
        return null
      })
  }

  stop(): void {
    const leg = this.current
    if (!leg) return
    this.current = null
    this.settled = leg
      .then((started) => (started ? this.ops.stop(started) : undefined))
      .catch((error: unknown) => this.ops.log('could not stop the typing sound', error))
  }

  /** Resolves once every request so far has finished. */
  async idle(): Promise<void> {
    await this.current
    await this.settled
  }
}

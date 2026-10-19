import { distinctEmails } from './order-detail'

// Which address an email goes to when the caller has orders on file.
//
// One address on file: use it. Several: the assistant must ask which, reading
// each aloud, and the answer has to be one of the addresses on file. A caller
// who names a different address entirely (for a summary, not an order link) is
// handled by the caller of this, not here.

export type EmailChoice =
  | { kind: 'use'; email: string }
  | { kind: 'ask'; emails: string[] }
  | { kind: 'none' }

export function chooseOrderEmail(onFile: readonly string[], chosen: string | null): EmailChoice {
  const emails = distinctEmails(onFile)
  if (emails.length === 0) return { kind: 'none' }
  const wanted = chosen?.trim().toLowerCase() ?? ''
  if (wanted) {
    const hit = emails.find((email) => email.toLowerCase() === wanted)
    if (hit) return { kind: 'use', email: hit }
    return { kind: 'ask', emails }
  }
  const only = emails.length === 1 ? emails[0] : undefined
  return only ? { kind: 'use', email: only } : { kind: 'ask', emails }
}

/** The message that tells the assistant to put the choice to the caller. */
export function askWhichEmailMessage(emails: readonly string[]): string {
  return `More than one email address is on this caller's orders: ${emails.join('; ')}. Read each one out to the caller as an address, naturally and without spelling it letter by letter, and ask which they would like it sent to. Then call this tool again with their choice, exactly as listed.`
}

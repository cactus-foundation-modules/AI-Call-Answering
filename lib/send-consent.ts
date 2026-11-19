import type { ToolResult } from './tool-handlers'

// ---------------------------------------------------------------------------
// Nothing leaves the call without the caller's say-so.
//
// The prompt already says so, and a model on a phone line still sent an order
// link nobody had asked for (DW000288: "is there a tracking link?" got an email
// instead of an answer). So every tool that sends something to the caller - an
// email, a text, a quote - also needs the caller's own yes, in their words, as
// a parameter. Asking for it makes the model stop and look for one; refusing
// without it means a skipped question costs a retry, not an unwanted email.
// It cannot prove the caller said it, only that the model claims they did, so
// it sits alongside the prompt rule, not instead of it.
// ---------------------------------------------------------------------------

/** Fewer letters than this is not an answer ("", "ok?" from a stray token). */
const MIN_AGREEMENT_LENGTH = 2

/** What the caller said to agree, as the tool received it, or null when there
 *  is no real agreement to go on. */
export function callerAgreement(value: string | undefined): string | null {
  const said = value?.trim() ?? ''
  return said.replace(/[^\p{L}\p{N}]/gu, '').length >= MIN_AGREEMENT_LENGTH ? said : null
}

/** The answer a send tool gives when the caller has not agreed: nothing sent,
 *  and what to do instead. */
export function notAgreedResult(what: string): ToolResult {
  return {
    ok: false,
    sent: false,
    message: `Nothing has been sent. Do not tell the caller anything was sent. Ask whether they would like ${what} sent to them, and if so how (text or email). Only once they say yes, call this again with their words in caller_agreed.`,
  }
}

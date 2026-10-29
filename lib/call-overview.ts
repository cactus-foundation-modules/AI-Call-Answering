import type { CallRecord } from './calls'
import { callerLabel } from './calls'
import { describeToolCall } from './tool-log'

// The written overview of a call: what the unified inbox shows at the top of a
// call's conversation and what the settings screen shows when a call is opened.
// Pure, so the wording is pinned by a test.

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'under a second'
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return `${rest} sec`
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} sec`
}

export function buildOverview(call: CallRecord): string {
  const lines: string[] = []
  if (call.status === 'in_progress') {
    lines.push('Phone assistant call in progress. The full overview appears when the call ends.')
  } else {
    lines.push(call.summary || 'No summary was produced for this call.')
  }
  lines.push('')
  lines.push(`Caller: ${callerLabel(call)}${call.fromNumber && call.callerName ? ` (${call.fromNumber})` : ''}`)
  if (call.status === 'completed') lines.push(`Length: ${formatDuration(call.durationSeconds)}`)
  if (call.verifiedOrders.length > 0) {
    lines.push(`Orders checked after identity was confirmed: ${call.verifiedOrders.join(', ')}`)
  }
  if (call.failedOrderChecks > 0) {
    lines.push(`Order checks that did not match: ${call.failedOrderChecks}`)
  }
  if (call.emailsSent > 0) {
    lines.push(`Emailed the caller what was discussed (${call.emailsSent}): ${call.emailedTo}`)
  }
  if (call.callbackNeeded) {
    lines.push('')
    lines.push(call.handledAt ? 'CALLBACK REQUESTED (dealt with)' : 'CALLBACK REQUESTED - please get back to this caller')
    lines.push(`Name: ${call.callerName || 'not given'}`)
    lines.push(`Email: ${call.callerEmail || 'not given'}`)
    lines.push(`About: ${call.callbackReason || 'not given'}`)
  }
  return lines.join('\n')
}

/** The transcript with each lookup slotted in where it happened, so a reader
 *  can see what the assistant had in front of it when it answered. A lookup
 *  goes before the first line spoken after it; one with no time goes last. */
export function buildTranscriptText(call: CallRecord): string {
  const log = call.toolLog ?? []
  if (call.transcript.length === 0 && log.length === 0) return 'No transcript was recorded.'
  const lines: string[] = []
  let next = 0
  for (const turn of call.transcript) {
    while (next < log.length && log[next]!.at !== null && turn.at !== null && log[next]!.at! <= turn.at) {
      lines.push(describeToolCall(log[next]!))
      next++
    }
    lines.push(`${turn.role === 'caller' ? 'Caller' : 'Assistant'}: ${turn.text}`)
  }
  for (; next < log.length; next++) lines.push(describeToolCall(log[next]!))
  return lines.join('\n')
}

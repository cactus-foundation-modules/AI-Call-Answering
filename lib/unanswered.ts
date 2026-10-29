import { prisma } from '@/lib/db/prisma'
import { upsertAlert } from '@/lib/notifications/alerts'
import type { TranscriptTurn } from './calls'

// ---------------------------------------------------------------------------
// What callers asked that the assistant could not answer.
//
// Every "I can't see that from here" is a gap: a missing FAQ, a page that does
// not say it, a tool that does not exist yet. Collected in two ways - the
// assistant notes it as it happens (note_unanswered), and after the call the
// transcript is read for the same admission made without a note - and shown as
// a weekly list on the settings screen, with a notification each Monday.
// ---------------------------------------------------------------------------

export type UnansweredSource = 'tool' | 'transcript'

export async function recordUnanswered(callId: string, question: string, source: UnansweredSource, topic: string = ''): Promise<void> {
  const text = question.replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!text) return
  await prisma.$executeRaw`
    INSERT INTO "acall_unanswered" ("call_id", "question", "source", "topic")
    VALUES (${callId}, ${text}, ${source}, ${topic.trim().slice(0, 60)})
  `
}

/** The assistant owning up to not knowing, in the words the prompt gives it and
 *  the ones it reaches for on its own. */
const ADMISSION = /\b(i can'?t see (that|this|it|any)|i (don'?t|do not) have (any |the )?(information|details|that|delivery|a date|anything)|i'?m (afraid|sorry),? i (don'?t|can'?t|do not)|i'?m not (able|sure) (to|i) (tell|say|find)|i'?d rather not (guess|point you))/i

/** Questions the transcript shows went unanswered: each admission, paired with
 *  what the caller had just said. Pure. */
export function unansweredFromTranscript(turns: readonly TranscriptTurn[]): string[] {
  const found: string[] = []
  let lastCaller = ''
  for (const turn of turns) {
    if (turn.role === 'caller') {
      lastCaller = turn.text
      continue
    }
    if (ADMISSION.test(turn.text) && lastCaller) {
      found.push(lastCaller.slice(0, 300))
      lastCaller = ''
    }
  }
  return found
}

/** After the call: files what the transcript shows, unless the assistant noted
 *  the gaps itself during the call (its own words are the better record). */
export async function fileTranscriptGaps(callId: string, turns: readonly TranscriptTurn[]): Promise<void> {
  const noted = await prisma.$queryRaw<Array<{ n: number | bigint }>>`
    SELECT COUNT(*) AS n FROM "acall_unanswered" WHERE "call_id" = ${callId}
  `
  if (Number(noted[0]?.n ?? 0) > 0) return
  for (const question of unansweredFromTranscript(turns)) await recordUnanswered(callId, question, 'transcript')
}

export type UnansweredRow = {
  id: string
  callId: string
  question: string
  topic: string
  source: UnansweredSource
  createdAt: string
  resolved: boolean
}

export async function listUnanswered(days: number): Promise<UnansweredRow[]> {
  const span = Math.min(Math.max(Math.round(days), 1), 365)
  const rows = await prisma.$queryRaw<Array<{ id: string; call_id: string; question: string; topic: string; source: string; created_at: Date; resolved_at: Date | null }>>`
    SELECT "id", "call_id", "question", "topic", "source", "created_at", "resolved_at" FROM "acall_unanswered"
    WHERE "created_at" > CURRENT_TIMESTAMP - make_interval(days => ${span}::int)
    ORDER BY "resolved_at" IS NOT NULL, "created_at" DESC
    LIMIT 500
  `
  return rows.map((row) => ({
    id: row.id,
    callId: row.call_id,
    question: row.question,
    topic: row.topic,
    source: row.source === 'transcript' ? 'transcript' : 'tool',
    createdAt: row.created_at.toISOString(),
    resolved: row.resolved_at !== null,
  }))
}

export async function setUnansweredResolved(id: string, resolved: boolean): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "acall_unanswered" SET "resolved_at" = ${resolved ? new Date() : null}::timestamp WHERE "id" = ${id}
  `
}

/** Monday's notification: how many went unanswered last week. Nothing is
 *  raised for a week with none. */
export async function announceWeeklyUnanswered(now: Date = new Date()): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ n: number | bigint }>>`
    SELECT COUNT(*) AS n FROM "acall_unanswered"
    WHERE "resolved_at" IS NULL AND "created_at" > CURRENT_TIMESTAMP - INTERVAL '7 days'
  `
  const count = Number(rows[0]?.n ?? 0)
  if (count === 0) return 0
  const week = now.toISOString().slice(0, 10)
  await upsertAlert({
    type: 'message',
    dedupeKey: `ai-call-answering:unanswered:${week}`,
    title: `${count} question${count === 1 ? '' : 's'} the phone assistant could not answer this week`,
    link: '/config?tab=ai-call-answering&sub=unanswered',
  })
  return count
}

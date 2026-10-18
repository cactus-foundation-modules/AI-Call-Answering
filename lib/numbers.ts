import { prisma } from '@/lib/db/prisma'

// Which of the site's Twilio numbers the assistant picks up.
//
// The numbers themselves belong to the twilio module; this table only records
// the assistant's own decision about each one.

export const ANSWER_MODES = ['always', 'when_unattended'] as const
export type AnswerMode = (typeof ANSWER_MODES)[number]

export type NumberAssignment = {
  phoneSid: string
  phoneNumber: string
  enabled: boolean
  mode: AnswerMode
}

function asMode(value: unknown): AnswerMode {
  return ANSWER_MODES.find((mode) => mode === value) ?? 'always'
}

function mapRow(row: Record<string, unknown>): NumberAssignment {
  return {
    phoneSid: row.phone_sid as string,
    phoneNumber: row.phone_number as string,
    enabled: row.enabled === true,
    mode: asMode(row.mode),
  }
}

export async function listAssignments(): Promise<NumberAssignment[]> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT phone_sid, phone_number, enabled, mode FROM "acall_numbers" ORDER BY created_at
  `
  return rows.map(mapRow)
}

export async function getAssignmentForNumber(phoneNumber: string): Promise<NumberAssignment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT phone_sid, phone_number, enabled, mode FROM "acall_numbers" WHERE phone_number = ${phoneNumber} LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function saveAssignment(input: NumberAssignment): Promise<void> {
  await prisma.$executeRaw`
    INSERT INTO "acall_numbers" ("phone_sid", "phone_number", "enabled", "mode", "updated_at")
    VALUES (${input.phoneSid}, ${input.phoneNumber}, ${input.enabled}, ${input.mode}, CURRENT_TIMESTAMP)
    ON CONFLICT ("phone_sid") DO UPDATE SET
      "phone_number" = EXCLUDED."phone_number",
      "enabled" = EXCLUDED."enabled",
      "mode" = EXCLUDED."mode",
      "updated_at" = CURRENT_TIMESTAMP
  `
}

/** Whether the assistant should take a call, given what the number's own rules
 *  say about it. Pure, so the rule is one readable line a test can pin. */
export function shouldAnswer(
  assignment: Pick<NumberAssignment, 'enabled' | 'mode'> | null,
  call: { open: boolean; wouldForward: boolean },
): boolean {
  if (!assignment || !assignment.enabled) return false
  if (assignment.mode === 'always') return true
  return !call.open || !call.wouldForward
}

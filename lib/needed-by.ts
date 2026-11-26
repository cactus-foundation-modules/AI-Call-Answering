// Copied from the chat assistant (modules/ai-agent-for-live-chat/lib/shop/needed-by.ts) and
// kept in step by hand: the two modules never import each other.
// ---------------------------------------------------------------------------
// "Can it be here by Wednesday?" answered by the tools, not the model. Pure,
// pinned by lib/shop/needed-by.test.ts.
//
// Learned on a live chat: told express would arrive on Tuesday the 1st, the
// assistant said that was too late for a visitor who needed it by Wednesday.
// A model is not to be trusted with the order of the days of the week, so the
// day the visitor names is turned into a date here and every delivery line is
// marked as arriving in time or not.
// ---------------------------------------------------------------------------

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

function iso(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function parseIso(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * The date a visitor's words mean, on or after `today` (an ISO date): an ISO
 * date, "today", "tomorrow", a weekday ("Wednesday", "by next Tuesday": the
 * next one, today counting), or a day of the month with or without its month
 * ("the 2nd", "2 December", "December 2nd"), the next such date. Null when the
 * words name no day.
 */
export function neededByDate(words: string, today: string): string | null {
  const start = parseIso(today)
  if (!start) return null
  const text = words.toLowerCase()
  const direct = parseIso(text)
  if (direct) return iso(direct)
  if (/\btoday\b/.test(text)) return iso(start)
  if (/\btomorrow\b/.test(text)) return iso(new Date(start.getTime() + 86_400_000))

  const monthAt = MONTHS.findIndex((month) => new RegExp(`\\b${month.slice(0, 3)}[a-z]*\\b`).test(text))
  const dayMatch = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(text)
  if (dayMatch) {
    const day = Number(dayMatch[1])
    if (day >= 1 && day <= 31) {
      for (let add = 0; add < 13; add++) {
        const month = monthAt >= 0 ? monthAt : (start.getUTCMonth() + add) % 12
        const yearsOn = monthAt >= 0 ? Math.floor(add) : Math.floor((start.getUTCMonth() + add) / 12)
        const year = start.getUTCFullYear() + (monthAt >= 0 ? add : yearsOn)
        const candidate = new Date(Date.UTC(year, month, day))
        if (candidate.getUTCMonth() !== month) continue
        if (candidate.getTime() >= start.getTime()) return iso(candidate)
        if (monthAt >= 0 && add > 1) break
      }
    }
  }

  const weekday = DAYS.findIndex((day) => new RegExp(`\\b${day}\\b`).test(text))
  if (weekday >= 0) {
    const ahead = (weekday - start.getUTCDay() + 7) % 7
    return iso(new Date(start.getTime() + ahead * 86_400_000))
  }
  return null
}

/** Whether a delivery due on `date` (ISO) is there by `neededBy` (ISO). */
export function arrivesInTime(date: string, neededBy: string): boolean {
  return date.slice(0, 10) <= neededBy.slice(0, 10)
}

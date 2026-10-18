import type { ConsignmentParcel } from '@/modules/shop/lib/consignment-parcels'

// ---------------------------------------------------------------------------
// Wording for when parcels arrived, for something that SPEAKS.
//
// A delivery the courier splits into several boxes can land on different days:
// three at teatime on Friday and the fourth on Saturday morning. The assistant
// used to be told one "delivered" date for the whole shipment and so said all
// the boxes arrived together. Each box is now reported with its own day and
// time, and boxes that arrived together are grouped so the answer stays short.
//
// Pure: instants and a time zone in, words out.
// ---------------------------------------------------------------------------

export type ParcelFacts = {
  parcel: number
  delivered: boolean
  /** "Friday 16 October at 7:29 pm", in the shop's own time zone. */
  deliveredAt: string | null
  signedForBy: string | null
  status: string | null
}

function momentParts(date: Date, timezone: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date)) out[part.type] = part.value
  return out
}

/** "Friday 16 October at 7:29 pm". */
export function describeDeliveryMoment(date: Date | string, timezone: string): string | null {
  const instant = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(instant.getTime())) return null
  const p = momentParts(instant, timezone)
  return `${p.weekday} ${p.day} ${p.month} at ${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toLowerCase()}`.trim()
}

function titleCase(name: string): string {
  return name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, lead: string, letter: string) => lead + letter.toUpperCase())
}

export function describeParcels(boxes: readonly ConsignmentParcel[], timezone: string): ParcelFacts[] {
  return boxes.map((box, index) => ({
    parcel: index + 1,
    delivered: box.delivered,
    deliveredAt: box.delivered && box.deliveredAt ? describeDeliveryMoment(box.deliveredAt, timezone) : null,
    signedForBy: box.delivered && box.receivedBy?.trim() ? titleCase(box.receivedBy.trim()) : null,
    status: box.stage?.trim() || null,
  }))
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

function numberWord(count: number): string {
  return NUMBER_WORDS[count] ?? String(count)
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function parcelNoun(count: number): string {
  return count === 1 ? 'parcel' : 'parcels'
}

/** The sentences the assistant can say as they stand, grouping boxes that
 *  arrived at the same moment: "Three of the four parcels were delivered on
 *  Friday 16 October at 7:29 pm. One parcel was delivered on Saturday 17
 *  October at 9:26 am." */
export function summariseParcels(parcels: readonly ParcelFacts[]): string {
  const total = parcels.length
  const groups = new Map<string, number>()
  let undated = 0
  let waiting = 0
  for (const parcel of parcels) {
    if (!parcel.delivered) waiting += 1
    else if (parcel.deliveredAt) groups.set(parcel.deliveredAt, (groups.get(parcel.deliveredAt) ?? 0) + 1)
    else undated += 1
  }
  const dated = [...groups.values()].reduce((sum, n) => sum + n, 0)

  const onlyMoment = groups.size === 1 ? [...groups.keys()][0] : undefined
  if (onlyMoment && dated === total) return `All ${numberWord(total)} parcels were delivered together on ${onlyMoment}.`

  const sentences: string[] = []
  for (const [moment, count] of groups) {
    const were = count === 1 ? 'was' : 'were'
    sentences.push(
      groups.size === 1
        ? `${capital(numberWord(count))} of the ${numberWord(total)} parcels ${were} delivered on ${moment}.`
        : `${capital(numberWord(count))} ${parcelNoun(count)} ${were} delivered on ${moment}.`,
    )
  }
  if (undated > 0) {
    sentences.push(`${capital(numberWord(undated))} ${parcelNoun(undated)} ${undated === 1 ? 'is' : 'are'} marked delivered but with no recorded time.`)
  }
  if (waiting > 0) {
    sentences.push(`${capital(numberWord(waiting))} ${parcelNoun(waiting)} ${waiting === 1 ? 'is' : 'are'} still to be delivered.`)
  }
  return sentences.join(' ')
}

export type DeliveryTimingWords = {
  dispatch: string
  transit: string
  totalWorkingDays: number
}

function workingDays(count: number): string {
  return count === 1 ? 'one working day' : `${numberWord(count)} working days`
}

/** A service's timing in speakable terms. Working days, never a calendar date:
 *  a date is only true for the moment it was worked out. */
export function describeDeliveryTiming(handlingDays: number, transitDays: number): DeliveryTimingWords {
  return {
    dispatch: handlingDays === 0
      ? 'dispatched the same working day if ordered before the cut-off'
      : `dispatched within ${workingDays(handlingDays)}`,
    transit: transitDays === 0 ? 'no further time on the road' : `${workingDays(transitDays)} on the road after dispatch`,
    totalWorkingDays: handlingDays + transitDays,
  }
}

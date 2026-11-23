import type { Message } from './api'

export const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

export function formatDateTime(iso: string, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(iso))
}

/** ISO string -> value for <input type="datetime-local"> in the browser's timezone. */
export function toLocalInput(iso: string | Date) {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function contactLabel(c: { name: string | null; jid: string }) {
  return c.name || `+${c.jid.split('@')[0]}`
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const dayName = (d: number) => DAY_NAMES[d]

/** [1,2,3,4,5] -> "Weekdays", [3] -> "Every Wednesday", [1,3,5] -> "Mon, Wed, Fri". */
export function describeDays(days: number[]) {
  const set = [...new Set(days)].sort()
  const key = set.join(',')
  if (set.length === 7) return 'Every day'
  if (key === '1,2,3,4,5') return 'Weekdays'
  if (key === '0,6') return 'Weekends'
  if (set.length === 1) return `Every ${DAY_NAMES[set[0]]}`
  // Monday-first reads more naturally.
  return [...set].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => DAY_SHORT[d]).join(', ')
}

/** "HH:MM" -> "8:00 AM" in the user's locale. */
export function formatTimeOfDay(hhmm: string) {
  const [h, m] = hhmm.split(':').map(Number)
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(2000, 0, 1, h, m))
}

export function formatDay(d: Date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' }).format(d)
}

/** "YYYY-MM-DD" of a Date in the browser's timezone. */
export function toLocalDate(d: Date) {
  return toLocalInput(d).slice(0, 10)
}

/**
 * The next `count` send times of a repeat, in the browser's timezone (mirrors the server's rule:
 * the start's local time, on the chosen days, from the start date to the end date).
 */
export function upcomingDates(start: Date, days: number[], count: number, endsOn?: string | null, maxCount?: number | null) {
  const out: Date[] = []
  if (!days.length || Number.isNaN(start.getTime())) return out
  const limit = Math.min(count, maxCount ?? count)
  const d = new Date(start)
  for (let i = 0; i < 800 && out.length < limit; i++) {
    if (endsOn && toLocalDate(d) > endsOn) break
    if (days.includes(d.getDay())) out.push(new Date(d))
    d.setDate(d.getDate() + 1) // keeps the wall-clock time across DST changes
  }
  return out
}

/** Which of a series' messages this send is, e.g. "Message 2 of 5". */
export function seriesPosition(series: NonNullable<Message['series']>, occurrence: number | null) {
  if (series.mode === 'ai') return '✨ AI-written'
  if (series.count <= 1 || occurrence === null) return 'Same message each time'
  return `Message ${(occurrence % series.count) + 1} of ${series.count}`
}

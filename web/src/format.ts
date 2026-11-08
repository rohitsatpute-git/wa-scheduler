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

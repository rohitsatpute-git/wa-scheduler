import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, type AiOptions, type MessageDetail, type Occasion, type Series, type SeriesInput } from '../api'
import { ContactPicker, type Picked } from '../components/ContactPicker'
import { MessageSuggestions } from '../components/MessageSuggestions'
import { loadPrefs, OCCASIONS, OccasionChips, StyleFields } from '../components/SuggestFields'
import {
  browserTimeZone,
  DAY_SHORT,
  dayName,
  describeDays,
  formatDay,
  toLocalDate,
  toLocalInput,
  upcomingDates,
} from '../format'

// Matches the server defaults (MAX_RECIPIENTS, series bodies); the server enforces the real limits.
const MAX_RECIPIENTS = 50
const MAX_BODIES = 100
const MAX_LENGTH = 4096

type Repeat = 'none' | 'daily' | 'weekdays' | 'weekly' | 'custom'
type BodyMode = 'same' | 'list' | 'ai'
type Ends = 'never' | 'on' | 'after'

const WEEKDAYS = [1, 2, 3, 4, 5]
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]
// Monday first, as most calendars here show it.
const PICKER_ORDER = [1, 2, 3, 4, 5, 6, 0]

function repeatFromDays(days: number[]): Repeat {
  const key = [...days].sort().join(',')
  if (days.length === 7) return 'daily'
  if (key === WEEKDAYS.join(',')) return 'weekdays'
  if (days.length === 1) return 'weekly'
  return 'custom'
}

function daysFor(repeat: Repeat, customDays: number[], start: Date): number[] {
  if (repeat === 'daily') return ALL_DAYS
  if (repeat === 'weekdays') return WEEKDAYS
  if (repeat === 'weekly') return Number.isNaN(start.getTime()) ? [] : [start.getDay()]
  if (repeat === 'custom') return customDays
  return []
}

/** Where the "First send" field starts when editing a series: its next send, else tomorrow at its time. */
function seriesStart(s: Series) {
  if (s.next && new Date(s.next.sendAt).getTime() > Date.now()) return toLocalInput(s.next.sendAt)
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return `${toLocalDate(d)}T${s.timeOfDay}`
}

export default function Compose() {
  const { id, seriesId } = useParams()
  const message = useQuery({
    queryKey: ['message', id],
    queryFn: () => api.message(id!),
    enabled: Boolean(id),
  })
  const series = useQuery({
    queryKey: ['series', seriesId],
    queryFn: () => api.series(seriesId!),
    enabled: Boolean(seriesId),
  })

  const loading = (id && message.isLoading) || (seriesId && series.isLoading)
  const error = (id && message.error) || (seriesId && series.error)
  if (loading) return <p className="muted">Loading…</p>
  if (error) return <p className="error">{error.message}</p>
  // Keyed so the form re-initialises when switching between new and edit.
  return <ComposeForm key={id ?? seriesId ?? 'new'} existing={message.data} existingSeries={series.data} />
}

function ComposeForm({ existing, existingSeries }: { existing?: MessageDetail; existingSeries?: Series }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const s = existingSeries

  const [recipients, setRecipients] = useState<Picked[]>(
    existing?.deliveries.map((d) => ({ jid: d.jid, name: d.name })) ?? s?.recipients ?? [],
  )
  // One entry unless the user sends a different message each time.
  const [bodies, setBodies] = useState<string[]>(() => {
    if (existing) return [existing.body]
    if (s?.mode === 'list' && s.bodies.length) return s.bodies
    return ['']
  })
  // Latest bodies, so quick successive picks each see the previous one (state updates are async).
  const latestBodies = useRef(bodies)
  const updateBodies = (fn: (b: string[]) => string[]) => {
    latestBodies.current = fn(latestBodies.current)
    setBodies(latestBodies.current)
  }
  const [bodyMode, setBodyMode] = useState<BodyMode>(() =>
    !s ? 'same' : s.mode === 'ai' ? 'ai' : s.bodies.length > 1 ? 'list' : 'same',
  )
  const [ai, setAi] = useState<AiOptions>(() => s?.ai ?? { occasion: 'good_morning', note: '', ...loadPrefs() })

  const [when, setWhen] = useState<'now' | 'later'>('later')
  const [sendAt, setSendAt] = useState(() =>
    s ? seriesStart(s) : toLocalInput(existing?.sendAt ?? new Date(Date.now() + 60 * 60_000)),
  )
  const [repeat, setRepeat] = useState<Repeat>(s ? repeatFromDays(s.days) : 'none')
  const [customDays, setCustomDays] = useState<number[]>(() => s?.days ?? [new Date(sendAt).getDay()])
  const [ends, setEnds] = useState<Ends>(s?.endsOn ? 'on' : s?.maxCount ? 'after' : 'never')
  const [endsOn, setEndsOn] = useState(() => s?.endsOn ?? toLocalDate(new Date(Date.now() + 30 * 86_400_000)))
  const [maxCount, setMaxCount] = useState(s?.maxCount ?? 10)

  const [suggestOpen, setSuggestOpen] = useState(false)
  // Text a picked suggestion replaced, so it can be undone.
  const [replaced, setReplaced] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [nowHour] = useState(() => new Date().getHours())

  // A single send of a series is edited on its own; the series' schedule isn't shown.
  const occurrenceOf = existing?.seriesId ? existing.series : null
  const repeating = Boolean(s) || (!existing && when === 'later' && repeat !== 'none')
  const mode: BodyMode = repeating ? bodyMode : 'same'

  const start = new Date(sendAt)
  const days = daysFor(repeat, customDays, start)
  const endDate = repeating && ends === 'on' ? endsOn : null
  const endCount = repeating && ends === 'after' ? maxCount : null
  const preview = repeating ? upcomingDates(start, days, Math.max(4, bodies.length), endDate, endCount) : []

  const sendHour = when === 'now' ? nowHour : sendAt ? start.getHours() : null
  const only = recipients.length === 1 ? recipients[0] : null
  const recipientName = only && !only.jid.endsWith('@g.us') && only.name ? only.name : undefined

  const setBody = (i: number, text: string) => updateBodies((b) => b.map((x, j) => (j === i ? text : x)))

  const pickSuggestion = (text: string) => {
    if (mode === 'list') {
      // Fill the first empty slot, else add one. The panel stays open to pick several.
      const current = latestBodies.current
      const empty = current.findIndex((b) => !b.trim())
      const at = empty >= 0 ? empty : current.length
      if (at >= MAX_BODIES) return
      updateBodies((b) => (empty >= 0 ? b.map((x, j) => (j === at ? text : x)) : [...b, text]))
      setAdded(`Added as message ${at + 1}`)
      return
    }
    setReplaced(bodies[0].trim() ? bodies[0] : null)
    setBody(0, text)
    setSuggestOpen(false)
  }

  const save = useMutation({
    mutationFn: async (): Promise<{ messageId: string | null }> => {
      if (repeating) {
        const input: SeriesInput = {
          recipients: recipients.map((r) => r.jid),
          timezone: browserTimeZone,
          startAt: start.toISOString(),
          days,
          endsOn: endDate,
          maxCount: endCount,
          mode: mode === 'ai' ? 'ai' : 'list',
          bodies: mode === 'list' ? bodies.filter((b) => b.trim()) : mode === 'same' ? [bodies[0]] : [],
          ai: mode === 'ai' ? ai : null,
        }
        const r = s ? await api.updateSeries(s.id, input) : await api.createSeries(input)
        return { messageId: r.firstMessageId }
      }
      const input = {
        body: bodies[0],
        recipients: recipients.map((r) => r.jid),
        sendAt: when === 'now' ? new Date().toISOString() : start.toISOString(),
        timezone: browserTimeZone,
      }
      if (existing) {
        await api.updateMessage(existing.id, input)
        return { messageId: existing.id }
      }
      return { messageId: (await api.createMessage(input)).id }
    },
    onSuccess: ({ messageId }) => {
      void qc.invalidateQueries({ queryKey: ['messages'] })
      void qc.invalidateQueries({ queryKey: ['series'] })
      if (messageId) void qc.invalidateQueries({ queryKey: ['message', messageId] })
      navigate(messageId ? `/messages/${messageId}` : '/?tab=repeating')
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  const hasBody =
    mode === 'ai'
      ? ai.occasion !== 'custom' || ai.note.trim().length > 0
      : mode === 'list'
        ? bodies.some((b) => b.trim())
        : bodies[0].trim().length > 0
  const scheduleOk =
    when === 'now' ||
    (Boolean(sendAt) &&
      (!repeating || (days.length > 0 && (ends !== 'on' || endsOn >= sendAt.slice(0, 10)) && preview.length > 0)))
  const canSubmit = recipients.length > 0 && hasBody && scheduleOk
  // Shown beside the disabled button, so it's clear what's missing.
  const blocker =
    recipients.length === 0
      ? 'Pick at least one recipient under To.'
      : !hasBody
        ? mode === 'ai'
          ? 'Describe the message for the AI to write.'
          : mode === 'list'
            ? 'Write at least one message.'
            : 'Write a message.'
        : !sendAt
          ? 'Choose a date and time.'
          : repeating && days.length === 0
            ? 'Pick at least one day to repeat on.'
            : repeating && ends === 'on' && endsOn < sendAt.slice(0, 10)
              ? 'The end date is before the first send.'
              : repeating && preview.length === 0
                ? 'None of the chosen days fall before the end date.'
                : null

  const filledCount = bodies.filter((b) => b.trim()).length
  const title = s ? 'Edit repeating message' : existing ? (occurrenceOf ? 'Edit this send' : 'Edit message') : 'New message'

  return (
    <form className="stack" onSubmit={submit}>
      <h1>{title}</h1>

      {occurrenceOf && existing?.seriesId && (
        <div className="notice info-notice">
          🔁 This is one send of a repeating message ({describeDays(occurrenceOf.days).toLowerCase()}). Changes here
          apply only to this send. <Link to={`/series/${existing.seriesId}/edit`}>Edit all future sends</Link>
        </div>
      )}

      <section className="card stack">
        <h2>To</h2>
        <ContactPicker selected={recipients} onChange={setRecipients} max={MAX_RECIPIENTS} />
      </section>

      <section className="card stack">
        <h2>When</h2>
        {!s && (
          <div className="segmented">
            <button type="button" className={when === 'later' ? 'active' : ''} onClick={() => setWhen('later')}>
              Schedule
            </button>
            <button type="button" className={when === 'now' ? 'active' : ''} onClick={() => setWhen('now')}>
              Send now
            </button>
          </div>
        )}
        {when === 'later' && (
          <>
            <div className="when-grid">
              <label className="field">
                {repeating ? 'First send' : 'Date and time'} ({browserTimeZone})
                <input
                  type="datetime-local"
                  value={sendAt}
                  min={toLocalInput(new Date())}
                  onChange={(e) => setSendAt(e.target.value)}
                  required
                />
              </label>
              {!existing && (
                <label className="field">
                  Repeat
                  <select value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
                    {!s && <option value="none">Doesn’t repeat</option>}
                    <option value="daily">Every day</option>
                    <option value="weekdays">Every weekday (Mon–Fri)</option>
                    <option value="weekly">
                      Weekly on {Number.isNaN(start.getTime()) ? 'the same day' : dayName(start.getDay())}
                    </option>
                    <option value="custom">Custom days…</option>
                  </select>
                </label>
              )}
            </div>

            {repeating && repeat === 'custom' && (
              <div className="field">
                On these days
                <div className="day-picker" role="group" aria-label="Days of the week">
                  {PICKER_ORDER.map((d) => {
                    const on = customDays.includes(d)
                    return (
                      <button
                        key={d}
                        type="button"
                        className={on ? 'active' : ''}
                        aria-pressed={on}
                        aria-label={dayName(d)}
                        onClick={() => setCustomDays((c) => (on ? c.filter((x) => x !== d) : [...c, d]))}
                      >
                        {DAY_SHORT[d].slice(0, 2)}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

            {repeating && (
              <>
                <div className="field">
                  Ends
                  <div className="row wrap ends-row">
                    <div className="segmented">
                      {(['never', 'on', 'after'] as const).map((e) => (
                        <button key={e} type="button" className={ends === e ? 'active' : ''} onClick={() => setEnds(e)}>
                          {e === 'never' ? 'Never' : e === 'on' ? 'On a date' : 'After'}
                        </button>
                      ))}
                    </div>
                    {ends === 'on' && (
                      <input
                        type="date"
                        className="auto-width"
                        value={endsOn}
                        min={sendAt.slice(0, 10)}
                        onChange={(e) => setEndsOn(e.target.value)}
                        aria-label="Last day"
                      />
                    )}
                    {ends === 'after' && (
                      <span className="row">
                        <input
                          type="number"
                          className="count-input"
                          min={1}
                          max={1000}
                          value={maxCount}
                          onChange={(e) => setMaxCount(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))}
                          aria-label="Number of sends"
                        />
                        <span className="muted">sends</span>
                      </span>
                    )}
                  </div>
                </div>

                <div className="repeat-summary" aria-live="polite">
                  {days.length === 0 ? (
                    <span className="error">Pick at least one day.</span>
                  ) : preview.length === 0 ? (
                    <span className="error">None of these days fall before the end date.</span>
                  ) : (
                    <>
                      <strong>
                        🔁 {describeDays(days)} at{' '}
                        {start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                      </strong>
                      <span className="muted small">
                        Next: {preview.slice(0, 4).map(formatDay).join(' · ')}
                        {preview.length > 4 || ends === 'never' ? ' …' : ''}
                      </span>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </section>

      <section className="card stack">
        <div className="row between">
          <h2>{mode === 'list' ? 'Messages' : 'Message'}</h2>
          {mode !== 'ai' && (
            <button
              type="button"
              className={`suggest-toggle${suggestOpen ? ' active' : ''}`}
              aria-expanded={suggestOpen}
              onClick={() => setSuggestOpen((o) => !o)}
            >
              ✨ Suggest
            </button>
          )}
        </div>

        {repeating && (
          <div className="segmented mode-switch" role="group" aria-label="What to send each time">
            <button type="button" className={bodyMode === 'same' ? 'active' : ''} onClick={() => setBodyMode('same')}>
              Same every time
            </button>
            <button type="button" className={bodyMode === 'list' ? 'active' : ''} onClick={() => setBodyMode('list')}>
              Different each time
            </button>
            <button type="button" className={bodyMode === 'ai' ? 'active' : ''} onClick={() => setBodyMode('ai')}>
              ✨ AI writes each one
            </button>
          </div>
        )}

        {mode !== 'ai' && (
          <div hidden={!suggestOpen}>
            <MessageSuggestions
              sendHour={sendHour}
              recipientName={recipientName}
              pickLabel={mode === 'list' ? 'Add' : 'Use'}
              onPick={pickSuggestion}
              onClose={() => setSuggestOpen(false)}
            />
          </div>
        )}

        {mode === 'same' && (
          <>
            <textarea
              rows={6}
              maxLength={MAX_LENGTH}
              placeholder="Type your message, or tap ✨ Suggest for ideas"
              value={bodies[0]}
              onChange={(e) => {
                setBody(0, e.target.value)
                setReplaced(null)
              }}
            />
            <div className="row between">
              <span className="muted small">
                {bodies[0].length}/{MAX_LENGTH}
              </span>
              {replaced !== null && (
                <span className="small">
                  Replaced your text.{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      setBody(0, replaced)
                      setReplaced(null)
                    }}
                  >
                    Undo
                  </button>
                </span>
              )}
            </div>
          </>
        )}

        {mode === 'list' && (
          <>
            <p className="muted small">
              One message per send, in order. After the last one it starts again from message 1. Tap ✨ Suggest to add
              several quickly.
            </p>
            <ol className="body-list">
              {bodies.map((b, i) => (
                <li key={i} className="body-item">
                  <div className="row between">
                    <span className="body-label">
                      Message {i + 1}
                      {preview[i] && b.trim() && <span className="muted"> · first on {formatDay(preview[i])}</span>}
                    </span>
                    {bodies.length > 1 && (
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Remove message ${i + 1}`}
                        onClick={() => updateBodies((x) => x.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={3}
                    maxLength={MAX_LENGTH}
                    placeholder={i === 0 ? 'First message' : 'Next message'}
                    value={b}
                    onChange={(e) => setBody(i, e.target.value)}
                  />
                </li>
              ))}
            </ol>
            <div className="row wrap">
              <button
                type="button"
                disabled={bodies.length >= MAX_BODIES}
                onClick={() => {
                  updateBodies((b) => [...b, ''])
                  setAdded(null)
                }}
              >
                + Add message
              </button>
              {added && <span className="muted small">{added}</span>}
            </div>
            {endCount !== null && filledCount > endCount && (
              <p className="notice small">
                It ends after {endCount} sends, so only the first {endCount} of these {filledCount} messages will go out.
              </p>
            )}
          </>
        )}

        {mode === 'ai' && <AiWriter value={ai} onChange={setAi} recipientName={recipientName} />}
      </section>

      <div className="row">
        <button type="submit" className="primary" disabled={!canSubmit || save.isPending}>
          {save.isPending
            ? 'Saving…'
            : s
              ? 'Save changes'
              : repeating
                ? 'Start repeating'
                : when === 'now'
                  ? 'Send now'
                  : existing
                    ? 'Save changes'
                    : 'Schedule message'}
        </button>
        <button type="button" className="link" onClick={() => navigate(-1)}>
          Back
        </button>
        {save.error && <span className="error">{save.error.message}</span>}
        {!canSubmit && !save.error && blocker && <span className="muted small">{blocker}</span>}
      </div>
    </form>
  )
}

/** Settings for "AI writes each one", with a sample so the user knows what to expect. */
function AiWriter({
  value,
  onChange,
  recipientName,
}: {
  value: AiOptions
  onChange: (v: AiOptions) => void
  recipientName?: string
}) {
  const sample = useMutation({ mutationFn: () => api.suggest({ ...value, note: value.note.trim(), recipientName }) })
  const detail = OCCASIONS.find((o) => o.id === value.occasion)?.detail
  const needsNote = value.occasion === 'custom' && !value.note.trim()

  return (
    <div className="stack ai-writer">
      <p className="muted small">
        A fresh message is written for every send. Each one is ready a send ahead, so you can read or edit it under
        Upcoming before it goes out.
      </p>
      <OccasionChips value={value.occasion} onChange={(occasion: Occasion) => onChange({ ...value, occasion })} />
      <input
        className="suggest-note"
        maxLength={200}
        placeholder={detail ?? 'Add a detail (optional)'}
        aria-label={value.occasion === 'custom' ? 'Describe the message' : 'Add a detail (optional)'}
        value={value.note}
        onChange={(e) => onChange({ ...value, note: e.target.value })}
      />
      <StyleFields value={value} onChange={(p) => onChange({ ...value, ...p })} />
      <div className="row wrap">
        <button type="button" disabled={sample.isPending || needsNote} onClick={() => sample.mutate()}>
          {sample.isPending ? 'Writing…' : sample.data ? '↻ Another sample' : 'Show a sample'}
        </button>
        {recipientName && <span className="muted small">Personalised for {recipientName}</span>}
        {sample.error && <span className="error small">{sample.error.message}</span>}
      </div>
      {sample.isPending && <div className="suggestion skeleton" aria-busy="true" />}
      {!sample.isPending && sample.data?.suggestions[0] && (
        <div className="sample-bubble">
          <span className="muted small">Sample</span>
          <p className="suggestion-text">{sample.data.suggestions[0]}</p>
        </div>
      )}
    </div>
  )
}

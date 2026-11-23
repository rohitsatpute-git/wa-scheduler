import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type Message, type Series } from '../api'
import { MessageActions } from '../components/MessageActions'
import { MessageBadge } from '../components/StatusBadge'
import { browserTimeZone, contactLabel, describeDays, formatDateTime, formatTimeOfDay, seriesPosition } from '../format'

type Tab = 'upcoming' | 'repeating' | 'history'
const TABS: { id: Tab; label: string }[] = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'repeating', label: 'Repeating' },
  { id: 'history', label: 'History' },
]

export default function Messages() {
  const [params, setParams] = useSearchParams()
  const tab: Tab = TABS.some((t) => t.id === params.get('tab')) ? (params.get('tab') as Tab) : 'upcoming'

  return (
    <div className="stack">
      <div className="row between">
        <h1>Messages</h1>
        <Link to="/messages/new" className="button primary">
          New message
        </Link>
      </div>

      <div className="segmented">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setParams(t.id === 'upcoming' ? {} : { tab: t.id }, { replace: true })}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'repeating' ? <SeriesList /> : <MessageList filter={tab} />}
    </div>
  )
}

function MessageList({ filter }: { filter: 'upcoming' | 'history' }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['messages', filter],
    queryFn: () => api.messages(filter),
  })
  return (
    <>
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error.message}</p>}
      {data?.length === 0 && (
        <div className="card empty">
          {filter === 'upcoming' ? (
            <>
              Nothing scheduled. <Link to="/messages/new">Schedule a message</Link>
            </>
          ) : (
            'No sent or cancelled messages yet.'
          )}
        </div>
      )}
      {data?.map((m) => <MessageCard key={m.id} message={m} />)}
    </>
  )
}

const listNames = (names: string[]) =>
  names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : '')

function MessageCard({ message: m }: { message: Message }) {
  return (
    <div className="card message-card">
      <Link to={`/messages/${m.id}`} className="message-main">
        <div className="row between">
          <strong>{formatDateTime(m.sendAt)}</strong>
          <MessageBadge status={m.status} />
        </div>
        {m.timezone !== browserTimeZone && (
          <div className="muted small">
            {formatDateTime(m.sendAt, m.timezone)} {m.timezone}
          </div>
        )}
        {m.series && (
          <div className="row wrap series-meta">
            <span className="repeat-chip">🔁 {describeDays(m.series.days)}</span>
            <span className="muted small">{seriesPosition(m.series, m.occurrence)}</span>
          </div>
        )}
        <div className="muted small">To {listNames(m.recipients)}</div>
        <p className="body-preview">{m.body}</p>
        {m.lastError && <p className="error small">{m.lastError}</p>}
      </Link>
      <MessageActions message={m} />
    </div>
  )
}

function SeriesList() {
  const { data, isLoading, error } = useQuery({ queryKey: ['series'], queryFn: api.seriesList })
  return (
    <>
      {isLoading && <p className="muted">Loading…</p>}
      {error && <p className="error">{error.message}</p>}
      {data?.length === 0 && (
        <div className="card empty stack center-text">
          <span>No repeating messages yet.</span>
          <span className="small">
            In a <Link to="/messages/new">new message</Link>, set <strong>Repeat</strong> to every day, weekdays or
            weekly, with the same text or a different one each time.
          </span>
        </div>
      )}
      {data?.map((s) => <SeriesCard key={s.id} series={s} />)}
    </>
  )
}

function SeriesCard({ series: s }: { series: Series }) {
  const qc = useQueryClient()
  const stop = useMutation({
    mutationFn: () => api.stopSeries(s.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['series'] })
      void qc.invalidateQueries({ queryKey: ['messages'] })
    },
  })
  const active = s.status === 'active'
  const what =
    s.mode === 'ai'
      ? '✨ AI writes each message'
      : s.bodies.length > 1
        ? `${s.bodies.length} messages, in turn`
        : 'Same message each time'
  const end = s.endsOn
    ? `until ${new Date(`${s.endsOn}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
    : s.maxCount
      ? `${s.sentCount} of ${s.maxCount} sent`
      : `${s.sentCount} sent`

  return (
    <div className={`card message-card${active ? '' : ' inactive'}`}>
      <div className="message-main">
        <div className="row between">
          <strong>
            🔁 {describeDays(s.days)} at {formatTimeOfDay(s.timeOfDay)}
          </strong>
          <span className={`badge ${active ? 'good' : 'muted'}`}>
            {active ? 'Active' : s.status === 'stopped' ? 'Stopped' : 'Finished'}
          </span>
        </div>
        <div className="muted small">
          To {listNames(s.recipients.map(contactLabel))} · {what} · {end}
          {s.timezone !== browserTimeZone && ` · ${s.timezone}`}
        </div>
        {s.next ? (
          <Link to={`/messages/${s.next.id}`} className="next-send">
            <span className="muted small">Next · {formatDateTime(s.next.sendAt)}</span>
            <span className="body-preview">{s.next.body}</span>
          </Link>
        ) : (
          active && <span className="muted small">Preparing the next send…</span>
        )}
      </div>
      <div className="actions">
        <Link to={`/series/${s.id}/edit`} className="button">
          {active ? 'Edit' : 'Edit & restart'}
        </Link>
        {active && (
          <button
            className="danger"
            disabled={stop.isPending}
            onClick={() => confirm('Stop repeating? The upcoming send is cancelled; past sends stay in History.') && stop.mutate()}
          >
            Stop
          </button>
        )}
        {stop.error && <span className="error small">{stop.error.message}</span>}
      </div>
    </div>
  )
}

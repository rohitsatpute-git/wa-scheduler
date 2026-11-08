import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type Message } from '../api'
import { MessageActions } from '../components/MessageActions'
import { MessageBadge } from '../components/StatusBadge'
import { browserTimeZone, formatDateTime } from '../format'

export default function Messages() {
  const [filter, setFilter] = useState<'upcoming' | 'history'>('upcoming')
  const { data, isLoading, error } = useQuery({
    queryKey: ['messages', filter],
    queryFn: () => api.messages(filter),
  })

  return (
    <div className="stack">
      <div className="row between">
        <h1>Messages</h1>
        <Link to="/messages/new" className="button primary">
          New message
        </Link>
      </div>

      <div className="segmented">
        <button className={filter === 'upcoming' ? 'active' : ''} onClick={() => setFilter('upcoming')}>
          Upcoming
        </button>
        <button className={filter === 'history' ? 'active' : ''} onClick={() => setFilter('history')}>
          History
        </button>
      </div>

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
    </div>
  )
}

function MessageCard({ message: m }: { message: Message }) {
  const names = m.recipients.slice(0, 3).join(', ') + (m.recipients.length > 3 ? ` +${m.recipients.length - 3}` : '')
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
        <div className="muted small">To {names}</div>
        <p className="body-preview">{m.body}</p>
        {m.lastError && <p className="error small">{m.lastError}</p>}
      </Link>
      <MessageActions message={m} />
    </div>
  )
}

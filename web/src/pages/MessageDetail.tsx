import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { MessageActions } from '../components/MessageActions'
import { DeliveryBadge, MessageBadge } from '../components/StatusBadge'
import { contactLabel, formatDateTime } from '../format'

export default function MessageDetail() {
  const { id } = useParams()
  const { data: m, isLoading, error } = useQuery({
    queryKey: ['message', id],
    queryFn: () => api.message(id!),
  })

  if (isLoading) return <p className="muted">Loading…</p>
  if (error || !m) return <p className="error">{error?.message ?? 'Not found'}</p>

  return (
    <div className="stack">
      <Link to="/" className="muted small">
        ← All messages
      </Link>
      <div className="row between">
        <h1>{formatDateTime(m.sendAt, m.timezone)}</h1>
        <MessageBadge status={m.status} />
      </div>
      <p className="muted small">Timezone: {m.timezone}</p>
      {m.lastError && <p className="error">{m.lastError}</p>}

      <div className="card">
        <p className="body-full">{m.body}</p>
      </div>

      <MessageActions message={m} />

      <div className="card">
        <h2>Recipients ({m.deliveries.length})</h2>
        <table className="deliveries">
          <thead>
            <tr>
              <th>Recipient</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {m.deliveries.map((d) => (
              <tr key={d.jid}>
                <td>{contactLabel(d)}</td>
                <td>
                  <DeliveryBadge status={d.status} />
                  {d.error && <div className="error small">{d.error}</div>}
                </td>
                <td className="muted small">{d.updatedAt ? formatDateTime(d.updatedAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

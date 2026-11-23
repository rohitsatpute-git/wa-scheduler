import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { api, CANCELLABLE, EDITABLE, type Message } from '../api'

export function MessageActions({ message: m }: { message: Pick<Message, 'id' | 'status' | 'seriesId'> }) {
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['messages'] })
    void qc.invalidateQueries({ queryKey: ['message', m.id] })
    void qc.invalidateQueries({ queryKey: ['series'] })
  }
  const inSeries = Boolean(m.seriesId)
  const sendNow = useMutation({ mutationFn: () => api.sendNow(m.id), onSuccess: refresh })
  const cancel = useMutation({ mutationFn: () => api.cancelMessage(m.id), onSuccess: refresh })
  const error = sendNow.error ?? cancel.error

  const editable = EDITABLE.includes(m.status)
  const cancellable = CANCELLABLE.includes(m.status)
  if (!editable && !cancellable) return null

  return (
    <div className="actions">
      {editable && (
        <Link to={`/messages/${m.id}/edit`} className="button">
          Edit
        </Link>
      )}
      {editable && (
        <button onClick={() => sendNow.mutate()} disabled={sendNow.isPending}>
          {m.status === 'failed' ? 'Retry now' : 'Send now'}
        </button>
      )}
      {cancellable && (
        <button
          className="danger"
          disabled={cancel.isPending}
          onClick={() =>
            confirm(inSeries ? 'Skip this send? The repeating message carries on with the next one.' : 'Cancel this message?') &&
            cancel.mutate()
          }
        >
          {inSeries ? 'Skip this one' : 'Cancel'}
        </button>
      )}
      {error && <span className="error small">{error.message}</span>}
    </div>
  )
}

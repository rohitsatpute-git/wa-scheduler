import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, type MessageDetail } from '../api'
import { ContactPicker, type Picked } from '../components/ContactPicker'
import { browserTimeZone, toLocalInput } from '../format'

// Matches the server default (MAX_RECIPIENTS); the server enforces the real limit.
const MAX_RECIPIENTS = 50

export default function Compose() {
  const { id } = useParams()
  const { data, isLoading, error } = useQuery({
    queryKey: ['message', id],
    queryFn: () => api.message(id!),
    enabled: Boolean(id),
  })

  if (id && isLoading) return <p className="muted">Loading…</p>
  if (id && error) return <p className="error">{error.message}</p>
  // Keyed so the form re-initialises when switching between new and edit.
  return <ComposeForm key={id ?? 'new'} existing={data} />
}

function ComposeForm({ existing }: { existing?: MessageDetail }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [recipients, setRecipients] = useState<Picked[]>(
    existing?.deliveries.map((d) => ({ jid: d.jid, name: d.name })) ?? [],
  )
  const [body, setBody] = useState(existing?.body ?? '')
  const [when, setWhen] = useState<'now' | 'later'>('later')
  const [sendAt, setSendAt] = useState(() =>
    toLocalInput(existing?.sendAt ?? new Date(Date.now() + 60 * 60_000)),
  )

  const save = useMutation({
    mutationFn: async () => {
      const input = {
        body,
        recipients: recipients.map((r) => r.jid),
        sendAt: when === 'now' ? new Date().toISOString() : new Date(sendAt).toISOString(),
        timezone: browserTimeZone,
      }
      if (existing) {
        await api.updateMessage(existing.id, input)
        return existing.id
      }
      return (await api.createMessage(input)).id
    },
    onSuccess: (messageId) => {
      void qc.invalidateQueries({ queryKey: ['messages'] })
      void qc.invalidateQueries({ queryKey: ['message', messageId] })
      navigate(`/messages/${messageId}`)
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    save.mutate()
  }

  const canSubmit = recipients.length > 0 && body.trim().length > 0 && (when === 'now' || sendAt)

  return (
    <form className="stack" onSubmit={submit}>
      <h1>{existing ? 'Edit message' : 'New message'}</h1>

      <section className="card stack">
        <h2>To</h2>
        <ContactPicker selected={recipients} onChange={setRecipients} max={MAX_RECIPIENTS} />
      </section>

      <section className="card stack">
        <h2>Message</h2>
        <textarea
          rows={6}
          maxLength={4096}
          placeholder="Type your message"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <span className="muted small">{body.length}/4096</span>
      </section>

      <section className="card stack">
        <h2>When</h2>
        <div className="segmented">
          <button type="button" className={when === 'later' ? 'active' : ''} onClick={() => setWhen('later')}>
            Schedule
          </button>
          <button type="button" className={when === 'now' ? 'active' : ''} onClick={() => setWhen('now')}>
            Send now
          </button>
        </div>
        {when === 'later' && (
          <label className="field">
            Date and time ({browserTimeZone})
            <input
              type="datetime-local"
              value={sendAt}
              min={toLocalInput(new Date())}
              onChange={(e) => setSendAt(e.target.value)}
              required
            />
          </label>
        )}
      </section>

      <div className="row">
        <button type="submit" className="primary" disabled={!canSubmit || save.isPending}>
          {save.isPending ? 'Saving…' : when === 'now' ? 'Send now' : existing ? 'Save changes' : 'Schedule message'}
        </button>
        <button type="button" className="link" onClick={() => navigate(-1)}>
          Back
        </button>
        {save.error && <span className="error">{save.error.message}</span>}
      </div>
    </form>
  )
}

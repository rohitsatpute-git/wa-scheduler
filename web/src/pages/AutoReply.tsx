import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { contactLabel, formatDateTime } from '../format'

export default function AutoReply() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['auto-reply'], queryFn: api.autoReply })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['auto-reply'] })
    void qc.invalidateQueries({ queryKey: ['contacts'] })
  }
  const update = useMutation({ mutationFn: api.updateAutoReply, onSuccess: refresh })
  const toggleContact = useMutation({
    mutationFn: ({ jid, enabled }: { jid: string; enabled: boolean }) => api.setContactAutoReply(jid, enabled),
    onSuccess: refresh,
  })

  if (isLoading) return <p className="muted">Loading…</p>
  if (error || !data) return <p className="error">{error?.message ?? 'Could not load auto-reply settings'}</p>

  if (!data.available) {
    return (
      <div className="stack">
        <h1>Auto-reply</h1>
        <div className="card">
          <p>
            Auto-reply needs an AI API key on the server. Set <code>GEMINI_API_KEY</code>, <code>OPENAI_API_KEY</code> or{' '}
            <code>ANTHROPIC_API_KEY</code> in the server's environment and restart it.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1>Auto-reply</h1>
        <Link to="/auto-reply/stats">View dashboard →</Link>
      </div>
      <p className="muted">
        AI answers messages from the contacts you choose, from your number. It stays quiet in a chat for 30
        minutes after you send a message there yourself, sends at most 10 replies per chat per hour, and can decide
        that a message needs no reply.
      </p>

      <div className="card stack">
        <label className="check">
          <input
            type="checkbox"
            checked={data.enabled}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ enabled: e.target.checked })}
          />
          <strong>Reply automatically</strong>
          <span className="muted small">
            {data.enabled
              ? `On for ${data.contacts.length} contact${data.contacts.length === 1 ? '' : 's'}`
              : 'Off for everyone'}
          </span>
        </label>

        {/* Keyed on the saved text so the editor resets whenever the server copy changes. */}
        <InstructionsEditor
          key={data.instructions}
          saved={data.instructions}
          saving={update.isPending}
          error={update.error?.message}
          onSave={(instructions) => update.mutate({ instructions })}
        />
      </div>

      <ContactsCard
        onToggle={(jid, enabled) => toggleContact.mutate({ jid, enabled })}
        pending={toggleContact.isPending}
        error={toggleContact.error?.message}
      />

      <div className="card">
        <h2>Recent auto-replies</h2>
        {data.recent.length === 0 ? (
          <p className="muted small">No auto-replies yet.</p>
        ) : (
          <ul className="reply-list">
            {data.recent.map((r, i) => (
              <li key={`${r.sentAt}-${i}`}>
                <span className="small">
                  <strong>To {contactLabel(r)}</strong> <span className="muted">· {formatDateTime(r.sentAt)}</span>
                </span>
                <p className="reply-text">{r.text}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function InstructionsEditor(props: {
  saved: string
  saving: boolean
  error?: string
  onSave: (instructions: string) => void
}) {
  const [instructions, setInstructions] = useState(props.saved)
  const dirty = instructions !== props.saved
  return (
    <>
      <label className="field">
        Instructions for the AI
        <textarea
          rows={5}
          maxLength={2000}
          placeholder="e.g. I'm on holiday until 20 Nov. Keep replies friendly and short. If someone asks about work, say I'll reply when I'm back."
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
        />
      </label>
      <div className="row">
        <button className="primary" disabled={!dirty || props.saving} onClick={() => props.onSave(instructions)}>
          {props.saving ? 'Saving…' : 'Save instructions'}
        </button>
        {props.error && <span className="error small">{props.error}</span>}
      </div>
    </>
  )
}

function ContactsCard(props: { onToggle: (jid: string, enabled: boolean) => void; pending: boolean; error?: string }) {
  const [search, setSearch] = useState('')
  const deferred = useDeferredValue(search.trim())
  const { data, isLoading } = useQuery({
    queryKey: ['contacts', deferred],
    queryFn: () => api.contacts(deferred),
  })
  // Auto-reply works for individual contacts with a phone number, not groups.
  const people = data?.filter((c) => !c.isGroup && c.jid.endsWith('@s.whatsapp.net'))
  const on = people?.filter((c) => c.autoReply) ?? []
  const off = people?.filter((c) => !c.autoReply) ?? []

  return (
    <div className="card stack">
      <h2>Contacts</h2>
      <input
        type="search"
        placeholder="Search contacts"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="contact-list">
        {isLoading && <p className="muted small pad">Loading contacts…</p>}
        {people?.length === 0 && <p className="muted small pad">{deferred ? 'No matches.' : 'No contacts yet.'}</p>}
        {[...on, ...off].map((c) => (
          <label key={c.jid} className="contact-row">
            <input
              type="checkbox"
              checked={c.autoReply}
              disabled={props.pending}
              onChange={(e) => props.onToggle(c.jid, e.target.checked)}
            />
            <span>{contactLabel(c)}</span>
            {c.name && <span className="muted small">+{c.jid.split('@')[0]}</span>}
            {c.autoReply && <span className="badge good">Auto-reply on</span>}
          </label>
        ))}
      </div>
      <p className="muted small">
        Turning a contact off also deletes the chat text stored for their auto-replies.
      </p>
      {props.error && <p className="error small">{props.error}</p>}
    </div>
  )
}

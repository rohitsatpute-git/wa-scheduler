import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useDeferredValue, useState } from 'react'
import { api, type Contact } from '../api'
import { contactLabel } from '../format'

export type Picked = Pick<Contact, 'jid' | 'name'>

interface Props {
  selected: Picked[]
  onChange: (next: Picked[]) => void
  max: number
}

export function ContactPicker({ selected, onChange, max }: Props) {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const deferred = useDeferredValue(search.trim())
  const { data, isLoading } = useQuery({
    queryKey: ['contacts', deferred],
    queryFn: () => api.contacts(deferred),
  })

  const [adding, setAdding] = useState(false)
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const add = useMutation({
    mutationFn: () => api.addContact(phone, name || undefined),
    onSuccess: (contact) => {
      void qc.invalidateQueries({ queryKey: ['contacts'] })
      if (!isSelected(contact.jid)) onChange([...selected, contact])
      setPhone('')
      setName('')
      setAdding(false)
    },
  })

  const resync = useMutation({
    mutationFn: api.resyncContacts,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['contacts'] }),
  })

  const isSelected = (jid: string) => selected.some((s) => s.jid === jid)
  const toggle = (c: Picked) =>
    onChange(isSelected(c.jid) ? selected.filter((s) => s.jid !== c.jid) : [...selected, c])

  return (
    <div className="picker">
      {selected.length > 0 && (
        <div className="chips">
          {selected.map((c) => (
            <span key={c.jid} className="chip">
              {contactLabel(c)}
              <button type="button" aria-label={`Remove ${contactLabel(c)}`} onClick={() => toggle(c)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        type="search"
        placeholder="Search contacts and groups"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <div className="contact-list">
        {isLoading && <p className="muted small pad">Loading contacts…</p>}
        {data?.length === 0 && (
          <p className="muted small pad">
            {deferred
              ? 'No matches.'
              : 'No contacts synced yet. WhatsApp sends them a minute or two after linking — or add a number below.'}
          </p>
        )}
        {data?.map((c) => {
          const checked = isSelected(c.jid)
          return (
            <label key={c.jid} className="contact-row">
              <input
                type="checkbox"
                checked={checked}
                disabled={!checked && selected.length >= max}
                onChange={() => toggle(c)}
              />
              <span>{contactLabel(c)}</span>
              {c.isGroup && <span className="badge muted">Group</span>}
              {c.name && !c.isGroup && <span className="muted small">+{c.jid.split('@')[0]}</span>}
            </label>
          )
        })}
      </div>

      {adding ? (
        <div className="row wrap">
          <input
            type="tel"
            placeholder="Number with country code"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <button type="button" onClick={() => add.mutate()} disabled={add.isPending || !phone.trim()}>
            {add.isPending ? 'Checking…' : 'Add'}
          </button>
          <button type="button" className="link" onClick={() => setAdding(false)}>
            Cancel
          </button>
          {add.error && <span className="error small">{add.error.message}</span>}
        </div>
      ) : (
        <div className="row">
          <button type="button" className="link" onClick={() => setAdding(true)}>
            + Add a number
          </button>
          <button type="button" className="link" onClick={() => resync.mutate()} disabled={resync.isPending}>
            {resync.isPending ? 'Refreshing contacts…' : 'Refresh contacts from WhatsApp'}
          </button>
          {resync.error && <span className="error small">{resync.error.message}</span>}
        </div>
      )}
      <p className="muted small">
        {selected.length}/{max} recipients
      </p>
    </div>
  )
}

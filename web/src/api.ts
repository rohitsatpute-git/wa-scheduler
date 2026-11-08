export type SessionStatus = 'pending_qr' | 'connecting' | 'connected' | 'disconnected' | 'logged_out'
export type MessageStatus = 'scheduled' | 'retrying' | 'sending' | 'done' | 'partial' | 'failed' | 'cancelled'
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed'

export interface Me {
  user: { id: string; phone: string; name: string | null }
  whatsapp: { status: SessionStatus }
}

export interface Contact {
  jid: string
  name: string | null
  isGroup: boolean
  manual: boolean
}

export interface Message {
  id: string
  body: string
  sendAt: string
  timezone: string
  status: MessageStatus
  lastError: string | null
  recipients: string[]
}

export interface MessageDetail extends Message {
  deliveries: {
    jid: string
    name: string | null
    status: DeliveryStatus | null
    error: string | null
    updatedAt: string | null
  }[]
}

export interface MessageInput {
  body: string
  recipients: string[]
  sendAt: string
  timezone: string
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    // The server requires a JSON content type on every write (CSRF defence).
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`)
  return data as T
}

export const api = {
  me: () => request<Me>('GET', '/auth/me'),
  startLink: (phone?: string) =>
    request<{ linkId: string; secret: string }>('POST', '/auth/link/start', { acceptTos: true, phone: phone || undefined }),
  completeLink: (linkId: string, secret: string) => request('POST', '/auth/link/complete', { linkId, secret }),
  logout: () => request('POST', '/auth/logout'),

  contacts: (search: string) => request<Contact[]>('GET', `/contacts?search=${encodeURIComponent(search)}`),
  addContact: (phone: string, name?: string) => request<Contact>('POST', '/contacts', { phone, name }),
  resyncContacts: () => request('POST', '/contacts/resync'),

  messages: (filter: 'upcoming' | 'history') => request<Message[]>('GET', `/messages?filter=${filter}`),
  message: (id: string) => request<MessageDetail>('GET', `/messages/${id}`),
  createMessage: (input: MessageInput) => request<{ id: string }>('POST', '/messages', input),
  updateMessage: (id: string, input: Partial<MessageInput>) => request('PATCH', `/messages/${id}`, input),
  sendNow: (id: string) => request('POST', `/messages/${id}/send-now`),
  cancelMessage: (id: string) => request('DELETE', `/messages/${id}`),
}

export const EDITABLE: MessageStatus[] = ['scheduled', 'retrying', 'failed']
export const CANCELLABLE: MessageStatus[] = ['scheduled', 'retrying', 'sending']

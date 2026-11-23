import { API_BASE, getToken, isNative, setToken } from './platform'

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
  autoReply: boolean
}

export interface AutoReply {
  /** False when the server has no Anthropic API key. */
  available: boolean
  enabled: boolean
  instructions: string
  contacts: { jid: string; name: string | null }[]
  recent: { jid: string; name: string | null; text: string; sentAt: string }[]
}

export type SkipReason = 'no_reply' | 'hourly_limit' | 'handoff' | 'error'

export interface AutoReplyStats {
  available: boolean
  enabled: boolean
  limits: { perChatPerHour: number; perUserPerHour: number; handoffMinutes: number }
  contacts: {
    jid: string
    name: string | null
    repliesLastHour: number
    /** Set when the chat is at its hourly limit: when the next reply is allowed. */
    limitFreesAt: string | null
    /** Set while auto-reply is paused because the user replied themselves. */
    handoffUntil: string | null
    received24h: number
    replies24h: number
    skipped24h: number
    lastMessageAt: string | null
  }[]
  hourly: { hour: string; replies: number; skipped: number }[]
  activity: {
    type: 'sent' | 'skipped'
    reason: SkipReason | null
    jid: string
    name: string | null
    /** The reply sent, or for a skip the contact message it stayed silent on. */
    text: string | null
    at: string
  }[]
}

export type Occasion =
  | 'good_morning' | 'good_night' | 'birthday' | 'festival' | 'thank_you' | 'congrats'
  | 'check_in' | 'reminder' | 'get_well' | 'anniversary' | 'custom'
export type Tone = 'warm' | 'fun' | 'formal' | 'romantic' | 'inspiring'
export type Language = 'english' | 'hindi' | 'hinglish' | 'marathi'
export type Length = 'short' | 'medium' | 'long'

export interface SuggestInput {
  occasion: Occasion
  tone: Tone
  language: Language
  length: Length
  emoji: boolean
  note: string
  recipientName?: string
}

export interface SuggestResult {
  suggestions: string[]
  /** 'templates' when the server has no AI key (or the model failed). */
  source: 'ai' | 'templates'
}

export interface Message {
  id: string
  body: string
  sendAt: string
  timezone: string
  status: MessageStatus
  lastError: string | null
  recipients: string[]
  /** Set when this is one send of a repeating message. */
  seriesId: string | null
  /** 0-based position of this send in its series. */
  occurrence: number | null
  series: { days: number[]; status: SeriesStatus; mode: SeriesMode; count: number } | null
}

export type SeriesStatus = 'active' | 'stopped' | 'ended'
/** 'list': the messages in order, then from the start. 'ai': a fresh AI message each time. */
export type SeriesMode = 'list' | 'ai'
export type AiOptions = Omit<SuggestInput, 'recipientName'>

export interface Series {
  id: string
  /** 0 = Sunday. */
  days: number[]
  /** "HH:MM" in `timezone`. */
  timeOfDay: string
  timezone: string
  startsOn: string
  endsOn: string | null
  maxCount: number | null
  mode: SeriesMode
  bodies: string[]
  ai: AiOptions | null
  status: SeriesStatus
  recipients: { jid: string; name: string | null }[]
  next: { id: string; sendAt: string; body: string } | null
  sentCount: number
}

export interface SeriesInput {
  recipients: string[]
  timezone: string
  /** First send; its local time is the time of every send. */
  startAt: string
  days: number[]
  endsOn: string | null
  maxCount: number | null
  mode: SeriesMode
  bodies: string[]
  ai: AiOptions | null
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
  const headers: Record<string, string> = {}
  // The server requires a JSON content type on every write (CSRF defence).
  if (method !== 'GET') headers['Content-Type'] = 'application/json'
  // The Android app signs in with a bearer token; the browser uses the cookie.
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers,
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
  completeLink: async (linkId: string, secret: string) => {
    const res = await request<{ ok: true; token?: string }>('POST', '/auth/link/complete', {
      linkId,
      secret,
      client: isNative ? 'app' : 'web',
    })
    if (res.token) await setToken(res.token)
  },
  logout: async () => {
    await request('POST', '/auth/logout')
    await setToken(null)
  },
  /** Unlinks WhatsApp and permanently deletes the account and all its data. */
  deleteAccount: async () => {
    await request('DELETE', '/auth/account')
    await setToken(null)
  },

  contacts: (search: string) => request<Contact[]>('GET', `/contacts?search=${encodeURIComponent(search)}`),
  addContact: (phone: string, name?: string) => request<Contact>('POST', '/contacts', { phone, name }),
  resyncContacts: () => request('POST', '/contacts/resync'),

  messages: (filter: 'upcoming' | 'history') => request<Message[]>('GET', `/messages?filter=${filter}`),
  message: (id: string) => request<MessageDetail>('GET', `/messages/${id}`),
  createMessage: (input: MessageInput) => request<{ id: string }>('POST', '/messages', input),
  updateMessage: (id: string, input: Partial<MessageInput>) => request('PATCH', `/messages/${id}`, input),
  sendNow: (id: string) => request('POST', `/messages/${id}/send-now`),
  cancelMessage: (id: string) => request('DELETE', `/messages/${id}`),

  autoReply: () => request<AutoReply>('GET', '/auto-reply'),
  autoReplyStats: () => request<AutoReplyStats>('GET', '/auto-reply/stats'),
  updateAutoReply: (input: { enabled?: boolean; instructions?: string }) => request('PUT', '/auto-reply', input),
  setContactAutoReply: (jid: string, enabled: boolean) =>
    request('PUT', `/auto-reply/contacts/${encodeURIComponent(jid)}`, { enabled }),

  seriesList: () => request<Series[]>('GET', '/series'),
  series: (id: string) => request<Series>('GET', `/series/${id}`),
  createSeries: (input: SeriesInput) => request<{ id: string; firstMessageId: string | null }>('POST', '/series', input),
  updateSeries: (id: string, input: SeriesInput) =>
    request<{ id: string; firstMessageId: string | null }>('PUT', `/series/${id}`, input),
  stopSeries: (id: string) => request('POST', `/series/${id}/stop`),

  suggest: (input: SuggestInput) => request<SuggestResult>('POST', '/suggestions', input),
}

export const EDITABLE: MessageStatus[] = ['scheduled', 'retrying', 'failed']
export const CANCELLABLE: MessageStatus[] = ['scheduled', 'retrying', 'sending']

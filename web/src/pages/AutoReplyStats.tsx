import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AutoReplyStats as Stats, type SkipReason } from '../api'
import { contactLabel, formatDateTime } from '../format'

const SKIP_LABEL: Record<SkipReason, string> = {
  no_reply: 'AI chose not to reply',
  hourly_limit: 'Hourly limit reached',
  handoff: 'Paused: you replied recently',
  error: 'Failed (see server log)',
}

const formatTime = (iso: string) => new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(new Date(iso))
const formatHour = (iso: string) => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).format(new Date(iso))

function minutesUntil(iso: string, now: number) {
  const m = Math.max(1, Math.ceil((new Date(iso).getTime() - now) / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`
}

/** Re-renders every 20 s so "frees in 12 min" counts down between fetches. */
function useNow() {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000)
    return () => clearInterval(t)
  }, [])
  return now
}

export default function AutoReplyStats() {
  // Live: the socket invalidates ['auto-reply', ...] on every reply or skip. The interval
  // catches limits and pauses expiring on their own.
  const { data, isLoading, error } = useQuery({
    queryKey: ['auto-reply', 'stats'],
    queryFn: api.autoReplyStats,
    refetchInterval: 60_000,
  })
  const now = useNow()

  if (isLoading) return <p className="muted">Loading…</p>
  if (error || !data) return <p className="error">{error?.message ?? 'Could not load the dashboard'}</p>

  const lastHourTotal = data.contacts.reduce((n, c) => n + c.repliesLastHour, 0)
  const sum = (k: 'replies' | 'skipped') => data.hourly.reduce((n, h) => n + h[k], 0)
  const received24h = data.contacts.reduce((n, c) => n + c.received24h, 0)

  return (
    <div className="stack">
      <div className="row between wrap">
        <div className="row">
          <h1>Auto-reply dashboard</h1>
          {!data.available ? (
            <span className="badge muted">No AI key</span>
          ) : data.enabled ? (
            <span className="badge good">● On</span>
          ) : (
            <span className="badge muted">Off</span>
          )}
        </div>
        <Link to="/auto-reply">Settings →</Link>
      </div>

      <div className="stat-grid">
        <StatTile
          label="Replies this hour"
          value={lastHourTotal}
          of={data.limits.perUserPerHour}
          note={`limit ${data.limits.perUserPerHour} across all chats`}
        />
        <StatTile label="Replies, last 24 h" value={sum('replies')} />
        <StatTile label="Stayed silent, last 24 h" value={sum('skipped')} />
        <StatTile label="Messages received, last 24 h" value={received24h} />
      </div>

      <ContactsTable stats={data} now={now} />
      <HourlyChart hourly={data.hourly} />
      <Activity activity={data.activity} />
    </div>
  )
}

function StatTile(props: { label: string; value: number; of?: number; note?: string }) {
  return (
    <div className="card stat-tile">
      <span className="muted small">{props.label}</span>
      <span className="stat-value">
        {props.value}
        {props.of !== undefined && <span className="muted stat-of"> / {props.of}</span>}
      </span>
      {props.note && <span className="muted small">{props.note}</span>}
    </div>
  )
}

function ContactsTable({ stats, now }: { stats: Stats; now: number }) {
  const limit = stats.limits.perChatPerHour
  return (
    <div className="card stack">
      <div>
        <h2>Contacts</h2>
        <p className="muted small">
          Each chat gets at most {limit} replies per rolling hour. Auto-reply pauses for{' '}
          {stats.limits.handoffMinutes} minutes after you send a message in a chat yourself.
        </p>
      </div>
      {stats.contacts.length === 0 ? (
        <p className="muted small">
          No contacts have auto-reply on. <Link to="/auto-reply">Choose contacts</Link>
        </p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>This hour</th>
                <th>Status</th>
                <th className="num">Received 24 h</th>
                <th className="num">Replied 24 h</th>
                <th className="num">Silent 24 h</th>
                <th>Last message</th>
              </tr>
            </thead>
            <tbody>
              {stats.contacts.map((c) => {
                const atLimit = c.repliesLastHour >= limit
                const level = atLimit ? 'bad' : c.repliesLastHour >= limit * 0.7 ? 'warn' : 'good'
                return (
                  <tr key={c.jid}>
                    <td>
                      <strong>{contactLabel(c)}</strong>
                      {c.name && <div className="muted small">+{c.jid.split('@')[0]}</div>}
                    </td>
                    <td>
                      <div className="meter-cell">
                        <div
                          className={`meter ${level}`}
                          role="meter"
                          aria-valuemin={0}
                          aria-valuemax={limit}
                          aria-valuenow={c.repliesLastHour}
                          aria-label={`${c.repliesLastHour} of ${limit} replies this hour`}
                        >
                          <span style={{ width: `${Math.min(100, (c.repliesLastHour / limit) * 100)}%` }} />
                        </div>
                        <span className="small">
                          {c.repliesLastHour}/{limit}
                        </span>
                      </div>
                    </td>
                    <td>
                      <ContactStatus c={c} stats={stats} now={now} />
                    </td>
                    <td className="num">{c.received24h}</td>
                    <td className="num">{c.replies24h}</td>
                    <td className="num">{c.skipped24h}</td>
                    <td className="small muted">{c.lastMessageAt ? formatDateTime(c.lastMessageAt) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function ContactStatus({ c, stats, now }: { c: Stats['contacts'][number]; stats: Stats; now: number }) {
  if (!stats.available || !stats.enabled) return <span className="badge muted">Off</span>
  const handoff = c.handoffUntil && new Date(c.handoffUntil).getTime() > now ? c.handoffUntil : null
  const limited = c.limitFreesAt && new Date(c.limitFreesAt).getTime() > now ? c.limitFreesAt : null
  if (limited)
    return (
      <span className="status-cell">
        <span className="badge bad">⏸ Limit reached</span>
        <span className="muted small">
          next reply at {formatTime(limited)} (in {minutesUntil(limited, now)})
        </span>
      </span>
    )
  if (handoff)
    return (
      <span className="status-cell">
        <span className="badge warn">⏸ You're chatting</span>
        <span className="muted small">
          resumes at {formatTime(handoff)} (in {minutesUntil(handoff, now)})
        </span>
      </span>
    )
  return <span className="badge good">✓ Active</span>
}

function HourlyChart({ hourly }: { hourly: Stats['hourly'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...hourly.map((h) => h.replies))
  const h = hover === null ? null : hourly[hover]

  return (
    <div className="card stack">
      <div>
        <h2>Replies per hour</h2>
        <p className="muted small">Last 24 hours</p>
      </div>
      <div className="bars-wrap">
        <span className="bars-max muted small">{max}</span>
        <div className="bars" onMouseLeave={() => setHover(null)}>
          {hourly.map((b, i) => (
            <div
              key={b.hour}
              className={`bar-col${hover === i ? ' active' : ''}`}
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              tabIndex={0}
              aria-label={`${formatHour(b.hour)}: ${b.replies} replies, ${b.skipped} silent`}
            >
              <div className="bar" style={{ height: `${(b.replies / max) * 100}%` }} />
            </div>
          ))}
          {h && hover !== null && (
            <div
              className="bar-tip"
              style={{ left: `${((hover + 0.5) / hourly.length) * 100}%` }}
              data-edge={hover < 3 ? 'start' : hover > hourly.length - 4 ? 'end' : undefined}
            >
              <strong>
                {formatHour(h.hour)} – {formatHour(new Date(new Date(h.hour).getTime() + 3_600_000).toISOString())}
              </strong>
              <span>
                {h.replies} {h.replies === 1 ? 'reply' : 'replies'}
              </span>
              <span className="muted">{h.skipped} stayed silent</span>
            </div>
          )}
        </div>
        <div className="bars-axis muted small">
          {hourly.map((b, i) => (
            <span key={b.hour}>{i % 6 === 0 || i === hourly.length - 1 ? formatHour(b.hour) : ''}</span>
          ))}
        </div>
      </div>
      <details>
        <summary className="small muted">Show as table</summary>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Hour</th>
              <th className="num">Replies</th>
              <th className="num">Silent</th>
            </tr>
          </thead>
          <tbody>
            {hourly
              .filter((b) => b.replies || b.skipped)
              .map((b) => (
                <tr key={b.hour}>
                  <td>{formatDateTime(b.hour)}</td>
                  <td className="num">{b.replies}</td>
                  <td className="num">{b.skipped}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

function Activity({ activity }: { activity: Stats['activity'] }) {
  return (
    <div className="card stack">
      <h2>Recent activity</h2>
      {activity.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <ul className="reply-list">
          {activity.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <span className="row wrap small activity-head">
                {a.type === 'sent' ? (
                  <span className="badge good">Replied</span>
                ) : (
                  <span className={`badge ${a.reason === 'error' ? 'bad' : 'muted'}`}>
                    {SKIP_LABEL[a.reason ?? 'no_reply']}
                  </span>
                )}
                <strong>
                  {a.type === 'sent' ? 'To' : 'From'} {contactLabel(a)}
                </strong>
                <span className="muted">· {formatDateTime(a.at)}</span>
              </span>
              {a.text && <p className={`reply-text${a.type === 'skipped' ? ' muted' : ''}`}>{a.text}</p>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

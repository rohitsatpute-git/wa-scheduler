import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { api, ApiError, type Me } from './api'
import { SessionBadge } from './components/StatusBadge'
import AutoReply from './pages/AutoReply'
import AutoReplyStats from './pages/AutoReplyStats'
import Compose from './pages/Compose'
import Connect from './pages/Connect'
import MessageDetail from './pages/MessageDetail'
import Messages from './pages/Messages'
import { APP_NAME, serverUrl } from './platform'
import { reconnectSocket, useRealtime } from './socket'

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () =>
      api.me().catch((err) => {
        if (err instanceof ApiError && err.status === 401) return null
        throw err
      }),
  })
}

export default function App() {
  return (
    <Routes>
      <Route path="/connect" element={<Connect />} />
      <Route element={<RequireAuth />}>
        <Route index element={<Messages />} />
        <Route path="messages/new" element={<Compose />} />
        <Route path="messages/:id" element={<MessageDetail />} />
        <Route path="messages/:id/edit" element={<Compose />} />
        <Route path="series/:seriesId/edit" element={<Compose />} />
        <Route path="auto-reply" element={<AutoReply />} />
        <Route path="auto-reply/stats" element={<AutoReplyStats />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

function RequireAuth() {
  const { data: me, isLoading, error } = useMe()
  if (isLoading) return <p className="center muted">Loading…</p>
  if (error) return <p className="center error">Couldn't reach the server: {error.message}</p>
  if (!me) return <Navigate to="/connect" replace />
  return <Layout me={me} />
}

function Layout({ me }: { me: Me }) {
  useRealtime()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      qc.clear()
      reconnectSocket()
      navigate('/connect')
    },
  })
  const deleteAccount = useMutation({
    mutationFn: api.deleteAccount,
    onSuccess: () => {
      qc.clear()
      reconnectSocket()
      navigate('/connect')
    },
  })
  const confirmDelete = () =>
    confirm(
      'Delete your account?\n\nThis unlinks WhatsApp and permanently deletes your contacts, scheduled and repeating messages, history and auto-reply data. It cannot be undone.',
    ) && deleteAccount.mutate()
  const status = me.whatsapp.status

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          {APP_NAME}
        </Link>
        <nav>
          <NavLink to="/" end>
            Messages
          </NavLink>
          <NavLink to="/messages/new">New message</NavLink>
          <NavLink to="/auto-reply" end>
            Auto-reply
          </NavLink>
          <NavLink to="/auto-reply/stats">Dashboard</NavLink>
        </nav>
        <div className="account">
          <SessionBadge status={status} />
          <span className="muted">{me.user.name ?? `+${me.user.phone}`}</span>
          <details className="account-menu">
            <summary aria-label="Account menu">⋯</summary>
            <div className="menu">
              <button className="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
                Log out
              </button>
              <a href={serverUrl('/privacy')} target="_blank" rel="noreferrer">
                Privacy policy
              </a>
              <button className="link danger" onClick={confirmDelete} disabled={deleteAccount.isPending}>
                {deleteAccount.isPending ? 'Deleting…' : 'Delete account'}
              </button>
              {deleteAccount.error && <span className="error small">{deleteAccount.error.message}</span>}
            </div>
          </details>
        </div>
      </header>

      {status !== 'connected' && (
        <div className="banner">
          {status === 'connecting' ? (
            'Reconnecting to WhatsApp… Messages due now will retry automatically.'
          ) : (
            <>
              WhatsApp is not connected, so scheduled messages can't be sent.{' '}
              <Link to="/connect">Link WhatsApp again</Link>
            </>
          )}
        </div>
      )}

      <main className="container">
        <Outlet />
      </main>
    </>
  )
}

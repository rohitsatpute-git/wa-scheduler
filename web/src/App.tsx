import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, NavLink, Navigate, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { api, ApiError, type Me } from './api'
import { SessionBadge } from './components/StatusBadge'
import Compose from './pages/Compose'
import Connect from './pages/Connect'
import MessageDetail from './pages/MessageDetail'
import Messages from './pages/Messages'
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
  const status = me.whatsapp.status

  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          WA Scheduler
        </Link>
        <nav>
          <NavLink to="/" end>
            Messages
          </NavLink>
          <NavLink to="/messages/new">New message</NavLink>
        </nav>
        <div className="account">
          <SessionBadge status={status} />
          <span className="muted">{me.user.name ?? `+${me.user.phone}`}</span>
          <button className="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Log out
          </button>
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

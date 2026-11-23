import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { io } from 'socket.io-client'
import type { Me, SessionStatus } from './api'
import { API_BASE, getToken } from './platform'

// One shared connection. The server reads the auth cookie (browser) or the `auth.token` (Android
// app) at handshake time, so call `reconnectSocket()` after signing in to join the user's room.
const options = {
  autoConnect: true,
  // A function, so each (re)connect sends the current token.
  auth: (cb: (data: object) => void) => {
    const token = getToken()
    cb(token ? { token } : {})
  },
}
export const socket = API_BASE ? io(API_BASE, options) : io(options)

export function reconnectSocket() {
  socket.disconnect().connect()
}

/** Keeps cached queries fresh from server push events. */
export function useRealtime() {
  const qc = useQueryClient()
  useEffect(() => {
    const onSession = ({ status }: { status: SessionStatus }) =>
      qc.setQueryData<Me | null>(['me'], (me) => (me ? { ...me, whatsapp: { status } } : me))
    const onMessage = ({ messageId }: { messageId: string }) => {
      void qc.invalidateQueries({ queryKey: ['messages'] })
      void qc.invalidateQueries({ queryKey: ['message', messageId] })
    }
    socket.on('session:status', onSession)
    socket.on('message:status', onMessage)
    socket.on('delivery:update', onMessage)
    const onAutoReply = () => void qc.invalidateQueries({ queryKey: ['auto-reply'] })
    socket.on('autoreply:sent', onAutoReply)
    socket.on('autoreply:skipped', onAutoReply)
    return () => {
      socket.off('autoreply:sent', onAutoReply)
      socket.off('autoreply:skipped', onAutoReply)
      socket.off('session:status', onSession)
      socket.off('message:status', onMessage)
      socket.off('delivery:update', onMessage)
    }
  }, [qc])
}

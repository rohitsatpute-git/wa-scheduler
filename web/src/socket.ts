import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { io } from 'socket.io-client'
import type { Me, SessionStatus } from './api'

// One shared connection. The server reads the auth cookie at handshake time,
// so call `reconnectSocket()` after signing in to join the user's room.
export const socket = io({ autoConnect: true })

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
    return () => {
      socket.off('session:status', onSession)
      socket.off('message:status', onMessage)
      socket.off('delivery:update', onMessage)
    }
  }, [qc])
}

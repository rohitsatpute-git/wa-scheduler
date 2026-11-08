import { useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { reconnectSocket, socket } from '../socket'

type Mode = 'qr' | 'phone'
type Phase = 'idle' | 'starting' | 'waiting' | 'finishing'

export default function Connect() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [accepted, setAccepted] = useState(false)
  const [mode, setMode] = useState<Mode>('qr')
  const [phone, setPhone] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [qr, setQr] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const link = useRef<{ linkId: string; secret: string } | null>(null)

  useEffect(() => {
    const subscribe = () => link.current && socket.emit('link:subscribe', link.current)
    const onQr = ({ qr }: { qr: string }) => setQr(qr)
    const onCode = ({ code }: { code: string }) => setCode(code)
    const onFailed = ({ reason }: { reason: string }) => {
      link.current = null
      setPhase('idle')
      setQr(null)
      setCode(null)
      setError(reason)
    }
    const onSuccess = async () => {
      const current = link.current
      if (!current) return
      link.current = null
      setPhase('finishing')
      try {
        await api.completeLink(current.linkId, current.secret)
        reconnectSocket()
        await qc.invalidateQueries({ queryKey: ['me'] })
        navigate('/')
      } catch (err) {
        onFailed({ reason: (err as Error).message })
      }
    }
    socket.on('connect', subscribe) // rejoin the link room after a socket reconnect
    socket.on('link:qr', onQr)
    socket.on('link:pairing-code', onCode)
    socket.on('link:success', onSuccess)
    socket.on('link:failed', onFailed)
    return () => {
      socket.off('connect', subscribe)
      socket.off('link:qr', onQr)
      socket.off('link:pairing-code', onCode)
      socket.off('link:success', onSuccess)
      socket.off('link:failed', onFailed)
    }
  }, [qc, navigate])

  async function start() {
    setError(null)
    setQr(null)
    setCode(null)
    setPhase('starting')
    try {
      link.current = await api.startLink(mode === 'phone' ? phone : undefined)
      socket.emit('link:subscribe', link.current)
      setPhase('waiting')
    } catch (err) {
      setPhase('idle')
      setError((err as Error).message)
    }
  }

  const busy = phase !== 'idle'

  return (
    <div className="connect">
      <h1>WA Scheduler</h1>
      <p className="muted">Link your WhatsApp to schedule messages to your contacts and groups.</p>

      {phase === 'idle' || phase === 'starting' ? (
        <div className="card stack">
          <div className="notice">
            <strong>Read this first.</strong> This app connects to WhatsApp as a linked device using an unofficial
            library. That breaks WhatsApp's Terms of Service, and WhatsApp may ban numbers that use it, especially for
            bulk or unsolicited messages. Only message people who expect to hear from you.
          </div>
          <label className="check">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />I understand
            the risk to my WhatsApp number
          </label>

          <div className="segmented">
            <button className={mode === 'qr' ? 'active' : ''} onClick={() => setMode('qr')}>
              Scan QR code
            </button>
            <button className={mode === 'phone' ? 'active' : ''} onClick={() => setMode('phone')}>
              Use pairing code
            </button>
          </div>

          {mode === 'phone' && (
            <label className="field">
              Your WhatsApp number, with country code
              <input
                type="tel"
                placeholder="e.g. 919876543210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </label>
          )}

          <button
            className="primary"
            disabled={!accepted || busy || (mode === 'phone' && phone.replace(/\D/g, '').length < 8)}
            onClick={start}
          >
            {phase === 'starting' ? 'Starting…' : 'Connect WhatsApp'}
          </button>
          {error && <p className="error">{error}</p>}
        </div>
      ) : (
        <div className="card stack center-text">
          {phase === 'finishing' ? (
            <p>Linked! Signing you in…</p>
          ) : mode === 'qr' ? (
            <>
              {qr ? (
                <div className="qr">
                  <QRCodeSVG value={qr} size={264} marginSize={2} />
                </div>
              ) : (
                <p className="muted">Generating QR code…</p>
              )}
              <ol className="steps">
                <li>Open WhatsApp on your phone</li>
                <li>
                  Go to <strong>Settings → Linked devices → Link a device</strong>
                </li>
                <li>Point your phone at this QR code</li>
              </ol>
            </>
          ) : (
            <>
              {code ? (
                <p className="pairing-code">{code.match(/.{1,4}/g)?.join('-')}</p>
              ) : (
                <p className="muted">Requesting pairing code…</p>
              )}
              <ol className="steps">
                <li>Open WhatsApp on your phone</li>
                <li>
                  Go to <strong>Settings → Linked devices → Link a device</strong>
                </li>
                <li>
                  Tap <strong>Link with phone number instead</strong> and enter this code
                </li>
              </ol>
            </>
          )}
        </div>
      )}
    </div>
  )
}

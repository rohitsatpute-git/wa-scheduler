import type { DeliveryStatus, MessageStatus, SessionStatus } from '../api'

const SESSION: Record<SessionStatus, [string, string]> = {
  connected: ['WhatsApp connected', 'good'],
  connecting: ['Reconnecting', 'warn'],
  pending_qr: ['Not linked', 'bad'],
  disconnected: ['Disconnected', 'bad'],
  logged_out: ['Not linked', 'bad'],
}

const MESSAGE: Record<MessageStatus, [string, string]> = {
  scheduled: ['Scheduled', 'info'],
  sending: ['Sending', 'warn'],
  retrying: ['Retrying', 'warn'],
  done: ['Sent', 'good'],
  partial: ['Partly sent', 'warn'],
  failed: ['Failed', 'bad'],
  cancelled: ['Cancelled', 'muted'],
}

const DELIVERY: Record<DeliveryStatus, [string, string]> = {
  queued: ['Queued', 'muted'],
  sent: ['Sent', 'info'],
  delivered: ['Delivered', 'good'],
  read: ['Read', 'good'],
  failed: ['Failed', 'bad'],
}

const Badge = ({ entry }: { entry: [string, string] }) => <span className={`badge ${entry[1]}`}>{entry[0]}</span>

export const SessionBadge = ({ status }: { status: SessionStatus }) => <Badge entry={SESSION[status]} />
export const MessageBadge = ({ status }: { status: MessageStatus }) => <Badge entry={MESSAGE[status]} />
export const DeliveryBadge = ({ status }: { status: DeliveryStatus | null }) => (
  <Badge entry={status ? DELIVERY[status] : ['Pending', 'muted']} />
)

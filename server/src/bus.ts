import { EventEmitter } from 'node:events';

export type SessionStatus = 'pending_qr' | 'connecting' | 'connected' | 'disconnected' | 'logged_out';
export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

export interface DeliveryUpdate {
  messageId: string;
  contactJid: string;
  status: DeliveryStatus;
  error?: string | null;
}

/** In-process event bus. Realtime (Socket.IO) subscribes and forwards to browsers. */
export const bus = new EventEmitter<{
  'link:qr': [linkId: string, qr: string];
  'link:pairing-code': [linkId: string, code: string];
  'link:success': [linkId: string, userId: string];
  'link:failed': [linkId: string, reason: string];
  'session:status': [userId: string, status: SessionStatus];
  'message:status': [userId: string, messageId: string, status: string];
  'delivery:update': [userId: string, update: DeliveryUpdate];
}>();

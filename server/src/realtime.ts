import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { COOKIE, verifyToken } from './auth.js';
import { bus } from './bus.js';
import { sessions } from './wa/sessionManager.js';

function readCookie(header: string | undefined, name: string) {
  for (const part of header?.split(';') ?? []) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

/**
 * Rooms: `user:<id>` for signed-in browsers, `link:<linkId>` for a browser waiting on a QR scan.
 * Browsers only listen; all writes go through the REST API.
 */
export function attachRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer);

  io.on('connection', (socket) => {
    const userId = verifyToken(readCookie(socket.handshake.headers.cookie, COOKIE));
    if (userId) void socket.join(`user:${userId}`);

    socket.on('link:subscribe', ({ linkId, secret }: { linkId?: string; secret?: string } = {}) => {
      if (typeof linkId !== 'string' || typeof secret !== 'string') return;
      const link = sessions.getLink(linkId, secret);
      if (!link) return void socket.emit('link:failed', { reason: 'This link has expired. Please try again.' });
      void socket.join(`link:${linkId}`);
      // Catch up on anything emitted before the browser subscribed.
      if (link.userId) socket.emit('link:success');
      else if (link.pairingCode) socket.emit('link:pairing-code', { code: link.pairingCode });
      else if (link.lastQr) socket.emit('link:qr', { qr: link.lastQr });
    });
  });

  bus.on('link:qr', (linkId, qr) => io.to(`link:${linkId}`).emit('link:qr', { qr }));
  bus.on('link:pairing-code', (linkId, code) => io.to(`link:${linkId}`).emit('link:pairing-code', { code }));
  bus.on('link:success', (linkId) => io.to(`link:${linkId}`).emit('link:success'));
  bus.on('link:failed', (linkId, reason) => io.to(`link:${linkId}`).emit('link:failed', { reason }));
  bus.on('session:status', (userId, status) => io.to(`user:${userId}`).emit('session:status', { status }));
  bus.on('message:status', (userId, messageId, status) =>
    io.to(`user:${userId}`).emit('message:status', { messageId, status }),
  );
  bus.on('delivery:update', (userId, update) => io.to(`user:${userId}`).emit('delivery:update', update));

  return io;
}

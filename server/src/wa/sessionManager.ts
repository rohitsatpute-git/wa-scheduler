import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import makeWASocket, {
  ALL_WA_PATCH_NAMES,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isLidUser,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  proto,
  type ConnectionState,
  type Contact,
  type WAMessageUpdate,
  type WASocket,
  type WAVersion,
} from '@whiskeysockets/baileys';
import { bus, type DeliveryStatus, type SessionStatus } from '../bus.js';
import { pool } from '../db.js';
import { logger, waLogger } from '../logger.js';
import { usePostgresAuthState } from './authState.js';

const LINK_TIMEOUT_MS = 3 * 60_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const VALID_JID = /@(s\.whatsapp\.net|lid|g\.us)$/;
const DELIVERY_ORDER: DeliveryStatus[] = ['queued', 'sent', 'delivered', 'read'];

/**
 * Where a contact event came from. Baileys reports address-book names and chat display names
 * in the same `name` field, so the source decides how much to trust it.
 */
type ContactSource = 'addressbook' | 'history' | 'push';

/**
 * Name ranks: a lower rank never overwrites a higher one (see contacts.name_rank).
 * 4 = typed by the user in this app (routes/contacts.ts), 3 = address book or group subject,
 * 2 = chat display name from history sync, 1 = the contact's own push name, 0 = none.
 */
const RANK = { addressbook: 3, history: 2, push: 1 } as const;

// WhatsApp hides numbers it won't reveal behind placeholders like "+91∙∙∙∙∙∙∙∙90".
const isMasked = (name: string) => name.includes('∙');

function pickName(c: Partial<Contact>, source: ContactSource): { name: string | null; rank: number } {
  const candidates: [string | null | undefined, number][] = [
    [c.name, RANK[source]],
    [c.notify, RANK.push],
    [c.verifiedName, RANK.push],
  ];
  for (const [raw, rank] of candidates) {
    const name = raw?.trim();
    if (name && !isMasked(name)) return { name, rank };
  }
  return { name: null, rank: 0 };
}

interface PendingLink {
  secret: string;
  phone?: string;
  pairingRequested?: boolean;
  lastQr?: string;
  pairingCode?: string;
  expiresTimer: NodeJS.Timeout;
}

interface Session {
  id: string;
  userId: string | null;
  sock: WASocket | null;
  status: SessionStatus;
  stopped: boolean;
  retries: number;
  reconnectTimer?: NodeJS.Timeout;
  link?: PendingLink;
  /** Contacts that arrived before the user row existed. */
  pendingContacts: { contacts: Partial<Contact>[]; source: ContactSource }[];
}

let cachedVersion: { version: WAVersion; fetchedAt: number } | null = null;
async function getWaVersion(): Promise<WAVersion | undefined> {
  if (cachedVersion && Date.now() - cachedVersion.fetchedAt < 60 * 60_000) return cachedVersion.version;
  try {
    const { version } = await fetchLatestBaileysVersion();
    cachedVersion = { version, fetchedAt: Date.now() };
    return version;
  } catch {
    return cachedVersion?.version; // fall back to the version bundled with Baileys
  }
}

function mapReceipt(status: number): DeliveryStatus | null {
  const S = proto.WebMessageInfo.Status;
  if (status === S.SERVER_ACK) return 'sent';
  if (status === S.DELIVERY_ACK) return 'delivered';
  if (status === S.READ || status === S.PLAYED) return 'read';
  return null;
}

/**
 * Owns one live Baileys socket per linked user. In this MVP everything runs in one process;
 * splitting sessions across several workers (with Redis leases) is a later phase.
 */
class SessionManager {
  private sessions = new Map<string, Session>();
  private byUser = new Map<string, string>();

  /** Reconnect every linked session from saved credentials. */
  async restoreAll() {
    await pool.query('delete from wa_sessions where user_id is null'); // abandoned links
    const { rows } = await pool.query<{ id: string; user_id: string }>(
      `select id, user_id from wa_sessions where status <> 'logged_out' and creds_encrypted is not null`,
    );
    for (const row of rows) {
      const s = this.newSession(row.id, row.user_id);
      await this.setStatus(s, 'connecting');
      this.connect(s).catch((err) => logger.error({ err, sessionId: s.id }, 'restore failed'));
    }
    logger.info({ count: rows.length }, 'restoring WhatsApp sessions');
  }

  async startLink(phone?: string): Promise<{ linkId: string; secret: string }> {
    const id = randomUUID();
    const secret = randomBytes(24).toString('base64url');
    await pool.query(`insert into wa_sessions (id, status) values ($1, 'pending_qr')`, [id]);
    const s = this.newSession(id, null);
    s.link = {
      secret,
      phone,
      expiresTimer: setTimeout(() => void this.abandonLink(id, 'Linking timed out. Please try again.'), LINK_TIMEOUT_MS),
    };
    await this.connect(s);
    return { linkId: id, secret };
  }

  /** Returns the pending link if the secret matches. */
  getLink(linkId: string, secret: string) {
    const s = this.sessions.get(linkId);
    if (!s?.link) return null;
    const a = Buffer.from(s.link.secret);
    const b = Buffer.from(secret);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { lastQr: s.link.lastQr, pairingCode: s.link.pairingCode, userId: s.userId };
  }

  /** One-time exchange of a successful link for the user id. */
  completeLink(linkId: string, secret: string): string | null {
    const link = this.getLink(linkId, secret);
    if (!link?.userId) return null;
    delete this.sessions.get(linkId)!.link;
    return link.userId;
  }

  getSocket(userId: string): WASocket | null {
    const s = this.sessionForUser(userId);
    return s?.status === 'connected' ? s.sock : null;
  }

  async getStatus(userId: string): Promise<SessionStatus> {
    const s = this.sessionForUser(userId);
    if (s) return s.status;
    const { rows } = await pool.query<{ status: SessionStatus }>('select status from wa_sessions where user_id = $1', [
      userId,
    ]);
    return rows[0]?.status ?? 'logged_out';
  }

  /** Unlink the device on WhatsApp and delete stored credentials. */
  async logout(userId: string) {
    const s = this.sessionForUser(userId);
    if (s) {
      s.stopped = true;
      await s.sock?.logout().catch(() => {});
      this.stop(s);
    }
    await pool.query('delete from wa_sessions where user_id = $1', [userId]);
    bus.emit('session:status', userId, 'logged_out');
  }

  /**
   * Re-download contacts from scratch: resets the app-state versions so WhatsApp sends full
   * snapshots (address-book names arrive as contacts.upsert), then refreshes groups.
   */
  async resyncContacts(userId: string): Promise<boolean> {
    const s = this.sessionForUser(userId);
    const sock = s?.status === 'connected' ? s.sock : null;
    if (!s || !sock) return false;
    await sock.authState.keys.set({
      'app-state-sync-version': Object.fromEntries(ALL_WA_PATCH_NAMES.map((name) => [name, null])),
    });
    await sock.resyncAppState(ALL_WA_PATCH_NAMES, true);
    await this.syncGroups(s, sock);
    return true;
  }

  async shutdown() {
    for (const s of this.sessions.values()) this.stop(s);
  }

  // ---------------------------------------------------------------------------

  private newSession(id: string, userId: string | null): Session {
    const s: Session = { id, userId, sock: null, status: 'pending_qr', stopped: false, retries: 0, pendingContacts: [] };
    this.sessions.set(id, s);
    if (userId) this.byUser.set(userId, id);
    return s;
  }

  private sessionForUser(userId: string) {
    const id = this.byUser.get(userId);
    return id ? this.sessions.get(id) : undefined;
  }

  private stop(s: Session) {
    s.stopped = true;
    clearTimeout(s.reconnectTimer);
    clearTimeout(s.link?.expiresTimer);
    s.sock?.end(undefined);
    s.sock = null;
    this.sessions.delete(s.id);
    if (s.userId && this.byUser.get(s.userId) === s.id) this.byUser.delete(s.userId);
  }

  private async abandonLink(id: string, reason: string) {
    const s = this.sessions.get(id);
    if (!s || s.userId) return;
    this.stop(s);
    await pool.query('delete from wa_sessions where id = $1', [id]);
    bus.emit('link:failed', id, reason);
  }

  private async setStatus(s: Session, status: SessionStatus) {
    s.status = status;
    await pool.query('update wa_sessions set status = $2, last_seen_at = now() where id = $1', [s.id, status]);
    if (s.userId) bus.emit('session:status', s.userId, status);
  }

  private async connect(s: Session) {
    if (s.stopped) return;
    const { state, saveCreds } = await usePostgresAuthState(s.id);
    const sock = makeWASocket({
      version: await getWaVersion(),
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, waLogger) },
      logger: waLogger,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    s.sock = sock;

    const guard =
      <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
      (...args: A) => {
        if (s.sock !== sock || s.stopped) return; // event from a replaced socket
        fn(...args).catch((err) => logger.error({ err, sessionId: s.id }, 'session event handler failed'));
      };

    sock.ev.on('creds.update', () => void saveCreds().catch((err) => logger.error({ err }, 'saveCreds failed')));
    sock.ev.on('connection.update', guard((u: Partial<ConnectionState>) => this.onConnectionUpdate(s, sock, u)));
    sock.ev.on('messaging-history.set', guard(({ contacts }) => this.saveContacts(s, contacts, 'history')));
    sock.ev.on('contacts.upsert', guard((contacts: Contact[]) => this.saveContacts(s, contacts, 'addressbook')));
    sock.ev.on('contacts.update', guard((contacts: Partial<Contact>[]) => this.saveContacts(s, contacts, 'push')));
    sock.ev.on('messages.update', guard((updates: WAMessageUpdate[]) => this.onMessageUpdates(s, updates)));
  }

  private async onConnectionUpdate(s: Session, sock: WASocket, u: Partial<ConnectionState>) {
    if (u.qr && s.link && !s.userId) {
      if (s.link.phone) {
        if (!s.link.pairingRequested) {
          s.link.pairingRequested = true;
          const code = await sock.requestPairingCode(s.link.phone);
          s.link.pairingCode = code;
          bus.emit('link:pairing-code', s.id, code);
        }
      } else {
        s.link.lastQr = u.qr;
        bus.emit('link:qr', s.id, u.qr);
      }
    }

    if (u.connection === 'open') await this.onOpen(s, sock);

    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      await this.onClose(s, code);
    }
  }

  private async onOpen(s: Session, sock: WASocket) {
    s.retries = 0;
    if (!s.userId) {
      const jid = jidNormalizedUser(sock.user!.id);
      const name = sock.user?.name ?? sock.user?.notify ?? null;
      const { rows } = await pool.query<{ id: string }>(
        `insert into users (wa_jid, display_name, tos_accepted_at) values ($1, $2, now())
         on conflict (wa_jid) do update
           set display_name = coalesce(excluded.display_name, users.display_name), tos_accepted_at = now()
         returning id`,
        [jid, name],
      );
      const userId = rows[0].id;

      // A user has at most one linked device: replace the old one.
      const old = this.sessionForUser(userId);
      if (old && old.id !== s.id) {
        old.stopped = true;
        await old.sock?.logout().catch(() => {});
        this.stop(old);
      }
      await pool.query('delete from wa_sessions where user_id = $1 and id <> $2', [userId, s.id]);
      await pool.query('update wa_sessions set user_id = $2 where id = $1', [s.id, userId]);

      s.userId = userId;
      this.byUser.set(userId, s.id);
      clearTimeout(s.link?.expiresTimer);
      bus.emit('link:success', s.id, userId);
      logger.info({ userId, sessionId: s.id }, 'WhatsApp linked');

      for (const { contacts, source } of s.pendingContacts.splice(0)) await this.saveContacts(s, contacts, source);
    }
    await this.setStatus(s, 'connected');
    this.syncGroups(s, sock).catch((err) => logger.warn({ err }, 'group sync failed'));
  }

  private async onClose(s: Session, code: number | undefined) {
    s.sock = null;

    // WhatsApp asks for a restart right after a QR scan; reconnect immediately with the same creds.
    if (code === DisconnectReason.restartRequired) return this.connect(s);

    if (!s.userId) {
      return this.abandonLink(
        s.id,
        code === DisconnectReason.loggedOut ? 'Linking was rejected.' : 'The QR code expired. Please try again.',
      );
    }

    if (code === DisconnectReason.loggedOut) {
      logger.info({ userId: s.userId }, 'WhatsApp session logged out from phone');
      await this.setStatus(s, 'logged_out');
      await pool.query('delete from wa_signal_keys where session_id = $1', [s.id]);
      await pool.query('update wa_sessions set creds_encrypted = null where id = $1', [s.id]);
      this.stop(s);
      return;
    }

    if (code === DisconnectReason.connectionReplaced) {
      // Another client opened this same session. Reconnecting would fight it.
      logger.warn({ userId: s.userId }, 'session replaced by another connection');
      await this.setStatus(s, 'disconnected');
      this.stop(s);
      return;
    }

    await this.setStatus(s, 'connecting');
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** s.retries++);
    logger.info({ userId: s.userId, code, delay }, 'WhatsApp disconnected, reconnecting');
    s.reconnectTimer = setTimeout(
      () => this.connect(s).catch((err) => logger.error({ err, sessionId: s.id }, 'reconnect failed')),
      delay,
    );
  }

  private async syncGroups(s: Session, sock: WASocket) {
    const groups = await sock.groupFetchAllParticipating();
    await this.saveContacts(
      s,
      Object.values(groups).map((g) => ({ id: g.id, name: g.subject })),
      'addressbook',
    );
  }

  private async saveContacts(s: Session, contacts: Partial<Contact>[], source: ContactSource) {
    if (!contacts?.length) return;
    if (!s.userId) {
      s.pendingContacts.push({ contacts, source });
      return;
    }

    // Dedupe by jid, keeping the best-ranked name. Prefer the phone-number JID over the LID.
    const byJid = new Map<string, { name: string | null; rank: number }>();
    for (const c of contacts) {
      const jid = c.phoneNumber ?? c.id;
      if (!jid || !VALID_JID.test(jid)) continue;
      const { name, rank } = pickName(c, source);
      if (!name && isLidUser(jid)) continue; // nothing a user could recognise
      const prev = byJid.get(jid);
      if (!prev || rank >= prev.rank) byJid.set(jid, { name, rank });
    }
    if (!byJid.size) return;

    const entries = [...byJid.entries()];
    await pool.query(
      `insert into contacts (user_id, jid, name, name_rank, is_group)
       select $1, t.jid, t.name, t.rank, t.jid like '%@g.us'
       from unnest($2::text[], $3::text[], $4::smallint[]) as t(jid, name, rank)
       on conflict (user_id, jid) do update set
         name = case when excluded.name_rank >= contacts.name_rank then excluded.name else contacts.name end,
         name_rank = greatest(contacts.name_rank, excluded.name_rank),
         updated_at = now()`,
      [s.userId, entries.map(([jid]) => jid), entries.map(([, v]) => v.name), entries.map(([, v]) => v.rank)],
    );
  }

  private async onMessageUpdates(s: Session, updates: WAMessageUpdate[]) {
    if (!s.userId) return;
    for (const { key, update } of updates) {
      if (!key.fromMe || !key.id || update.status == null) continue;
      const status = mapReceipt(update.status);
      if (!status) continue;
      const { rows } = await pool.query<{ scheduled_message_id: string; contact_jid: string }>(
        `update deliveries d set status = $2, updated_at = now()
         from message_recipients r join scheduled_messages m on m.id = r.scheduled_message_id
         where d.recipient_id = r.id and m.user_id = $3 and d.wa_message_id = $1
           and array_position($4::text[], d.status) < array_position($4::text[], $2)
         returning r.scheduled_message_id, r.contact_jid`,
        [key.id, status, s.userId, DELIVERY_ORDER],
      );
      for (const row of rows) {
        bus.emit('delivery:update', s.userId, {
          messageId: row.scheduled_message_id,
          contactJid: row.contact_jid,
          status,
        });
      }
    }
  }
}

export const sessions = new SessionManager();

import { bus } from './bus.js';
import { config } from './config.js';
import { pool } from './db.js';
import { logger } from './logger.js';
import { ensureSeries } from './series.js';
import { sessions } from './wa/sessionManager.js';

/**
 * Postgres is the queue. Every `pollIntervalMs` (and whenever something changes) a watcher claims
 * due messages by flipping them to 'sending', then hands them to an in-process pool of senders.
 *
 * - At most `sendConcurrency` messages send at once, and at most one per user.
 * - A sender refreshes `locked_at` before each recipient. A 'sending' row whose heartbeat is
 *   older than STALE_AFTER belonged to a process that died, and is retried.
 * - Retries back off 30s, 60s; after MAX_ATTEMPTS the message is 'partial' or 'failed'.
 */

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 30_000;
const STALE_AFTER = '3 minutes';
/** On startup, a message more than this late is marked failed instead of being sent. */
const MISSED_WINDOW = '15 minutes';
/** How long shutdown waits for senders to reach a safe stopping point. */
const SHUTDOWN_GRACE_MS = 20_000;

/** When a message is next due: its retry time if it has one, else its scheduled time. */
const DUE = 'coalesce(next_attempt_at, send_at)';
const ANY_DELIVERED = `exists (
  select 1 from deliveries d join message_recipients r on r.id = d.recipient_id
  where r.scheduled_message_id = m.id and d.status <> 'failed')`;

interface Claimed {
  id: string;
  userId: string;
  body: string;
  attempts: number;
}

const active = new Map<string, Promise<void>>();
let timer: NodeJS.Timeout | undefined;
let ticking = false;
let rerun = false;
let stopping = false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const randomGap = () => config.sendGapMinMs + Math.random() * (config.sendGapMaxMs - config.sendGapMinMs);

export async function startScheduler() {
  const { rows } = await pool.query<{ id: string; user_id: string }>(
    `update scheduled_messages
        set status = 'failed', last_error = 'Missed the send window while the server was down', updated_at = now()
      where status in ('scheduled', 'retrying') and ${DUE} < now() - interval '${MISSED_WINDOW}'
      returning id, user_id`,
  );
  for (const r of rows) bus.emit('message:status', r.user_id, r.id, 'failed');
  if (rows.length) logger.warn({ count: rows.length }, 'marked missed messages as failed');

  timer = setInterval(() => void tick(), config.pollIntervalMs);
  void tick();
}

/** Check for due messages now instead of waiting for the next poll. */
export function wakeScheduler() {
  void tick();
}

export async function stopScheduler() {
  stopping = true;
  clearInterval(timer);
  // Senders stop before their next recipient and put the message back in the queue.
  await Promise.race([Promise.allSettled(active.values()), sleep(SHUTDOWN_GRACE_MS)]);
}

async function tick() {
  if (stopping) return;
  if (ticking) return void (rerun = true);
  ticking = true;
  try {
    do {
      rerun = false;
      await recoverStale();
      const free = config.sendConcurrency - active.size;
      if (free > 0) for (const m of await claim(free)) start(m);
      // Repeating messages: once an occurrence is sending, skipped or failed, schedule the next.
      // Not awaited: writing an AI message can take a few seconds.
      void ensureSeries().catch((err) => logger.error({ err }, 'series check failed'));
    } while (rerun && !stopping);
  } catch (err) {
    logger.error({ err }, 'scheduler tick failed');
  } finally {
    ticking = false;
  }
}

/** Claim up to `limit` due messages, the earliest per user, skipping users who already have one sending. */
async function claim(limit: number) {
  const { rows } = await pool.query<Claimed>(
    `update scheduled_messages m
        set status = 'sending', attempts = attempts + 1, locked_at = now(), updated_at = now()
      where m.id in (
        select id from (
          select distinct on (user_id) id, user_id, ${DUE} as due
            from scheduled_messages
           where status in ('scheduled', 'retrying') and ${DUE} <= now()
           order by user_id, ${DUE}
        ) firsts
        where not exists (select 1 from scheduled_messages s where s.user_id = firsts.user_id and s.status = 'sending')
        order by due
        limit $1
      )
      and m.status in ('scheduled', 'retrying')
      returning m.id, m.user_id as "userId", m.body, m.attempts`,
    [limit],
  );
  return rows;
}

/**
 * Requeue 'sending' rows abandoned by a process that crashed or was killed mid-send. One that is
 * long past its send time (the server was down) is closed instead of going out hours late.
 */
async function recoverStale() {
  const late = `m.send_at < now() - interval '${MISSED_WINDOW}'`;
  const { rows } = await pool.query<{ id: string; user_id: string; status: string }>(
    `update scheduled_messages m set
        status = case when m.attempts < $2 and not ${late} then 'retrying'
                      when ${ANY_DELIVERED} then 'partial' else 'failed' end,
        next_attempt_at = now(),
        last_error = case when ${late} then 'Missed the send window while the server was down'
                          else 'Interrupted while sending' end,
        locked_at = null, updated_at = now()
      where m.status = 'sending'
        and coalesce(m.locked_at, m.updated_at) < now() - interval '${STALE_AFTER}'
        and not (m.id = any($1::uuid[]))
      returning m.id, m.user_id, m.status`,
    [[...active.keys()], MAX_ATTEMPTS],
  );
  for (const r of rows) bus.emit('message:status', r.user_id, r.id, r.status);
  if (rows.length) logger.warn({ count: rows.length }, 'recovered stale sends');
}

function start(m: Claimed) {
  const run = processMessage(m)
    .catch((err) => logger.error({ err, messageId: m.id }, 'sender crashed'))
    .finally(() => {
      active.delete(m.id);
      void tick(); // a slot is free, and this user's next message may be due
    });
  active.set(m.id, run);
}

async function processMessage(m: Claimed) {
  bus.emit('message:status', m.userId, m.id, 'sending');
  let error: string | null = null;

  try {
    // Skip recipients that already got it on an earlier attempt.
    const { rows: recipients } = await pool.query<{ id: string; contact_jid: string }>(
      `select r.id, r.contact_jid from message_recipients r
       where r.scheduled_message_id = $1
         and not exists (select 1 from deliveries d where d.recipient_id = r.id and d.status <> 'failed')
       order by r.contact_jid`,
      [m.id],
    );

    let failures = 0;
    for (const [i, r] of recipients.entries()) {
      if (i > 0) await sleep(randomGap());
      if (stopping) return void (await release(m));
      // Doubles as the cancel check: a cancelled message is no longer 'sending'.
      if (!(await heartbeat(m.id))) return;

      const sock = sessions.getSocket(m.userId);
      if (!sock) throw new Error('WhatsApp is not connected');
      try {
        await sock.sendPresenceUpdate('composing', r.contact_jid).catch(() => {});
        await sleep(800 + Math.random() * 1200);
        const sent = await sock.sendMessage(r.contact_jid, { text: m.body });
        await pool.query(`insert into deliveries (recipient_id, status, wa_message_id) values ($1, 'sent', $2)`, [
          r.id,
          sent?.key.id ?? null,
        ]);
        bus.emit('delivery:update', m.userId, { messageId: m.id, contactJid: r.contact_jid, status: 'sent' });
      } catch (err) {
        failures++;
        const msg = err instanceof Error ? err.message : String(err);
        await pool.query(`insert into deliveries (recipient_id, status, error) values ($1, 'failed', $2)`, [r.id, msg]);
        bus.emit('delivery:update', m.userId, { messageId: m.id, contactJid: r.contact_jid, status: 'failed', error: msg });
        logger.warn({ messageId: m.id, jid: r.contact_jid, err }, 'send failed');
      }
    }
    if (failures) error = `${failures} of ${recipients.length} recipients failed`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (!error) return void (await finish(m, 'done', null));
  if (m.attempts < MAX_ATTEMPTS) {
    const delayMs = BACKOFF_BASE_MS * 2 ** (m.attempts - 1);
    const { rowCount } = await pool.query(
      `update scheduled_messages
          set status = 'retrying', next_attempt_at = now() + $2 * interval '1 millisecond',
              last_error = $3, locked_at = null, updated_at = now()
        where id = $1 and status = 'sending'`,
      [m.id, delayMs, error],
    );
    if (rowCount) bus.emit('message:status', m.userId, m.id, 'retrying');
    return;
  }
  const { rows } = await pool.query<{ partial: boolean }>(
    `select ${ANY_DELIVERED} as partial from scheduled_messages m where m.id = $1`,
    [m.id],
  );
  await finish(m, rows[0]?.partial ? 'partial' : 'failed', error);
}

/** Final status. Only applies while we still own the row, so a cancel is never overwritten. */
async function finish(m: Claimed, status: 'done' | 'partial' | 'failed', error: string | null) {
  const { rowCount } = await pool.query(
    `update scheduled_messages set status = $2, last_error = $3, locked_at = null, updated_at = now()
      where id = $1 and status = 'sending'`,
    [m.id, status, error],
  );
  if (rowCount) bus.emit('message:status', m.userId, m.id, status);
}

/** Refresh our claim. Returns false if the message was cancelled or taken over. */
async function heartbeat(id: string) {
  const { rowCount } = await pool.query(
    `update scheduled_messages set locked_at = now() where id = $1 and status = 'sending'`,
    [id],
  );
  return rowCount === 1;
}

/** Shutting down mid-send: put the message back without using up an attempt. */
async function release(m: Claimed) {
  const status = m.attempts > 1 ? 'retrying' : 'scheduled';
  const { rowCount } = await pool.query(
    `update scheduled_messages
        set status = $2, attempts = attempts - 1, next_attempt_at = now(), locked_at = null, updated_at = now()
      where id = $1 and status = 'sending'`,
    [m.id, status],
  );
  if (rowCount) bus.emit('message:status', m.userId, m.id, status);
}

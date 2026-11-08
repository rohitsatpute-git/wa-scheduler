import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireAuth, userId } from '../auth.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { wakeScheduler } from '../scheduler.js';

export const messagesRouter = Router();
messagesRouter.use(requireAuth);
messagesRouter.param('id', (_req, res, next, id: string) => {
  if (!z.uuid().safeParse(id).success) return void res.status(404).json({ error: 'Not found' });
  next();
});

const EDITABLE = ['scheduled', 'retrying', 'failed'];
const CANCELLABLE = ['scheduled', 'retrying', 'sending'];
const UPCOMING = ['scheduled', 'retrying', 'sending'];

const isTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const messageSchema = z.object({
  body: z.string().trim().min(1, 'Message is empty').max(4096),
  recipients: z
    .array(z.string())
    .min(1, 'Pick at least one recipient')
    .max(config.maxRecipients, `At most ${config.maxRecipients} recipients per message`)
    .transform((r) => [...new Set(r)]),
  sendAt: z.iso
    .datetime({ offset: true })
    .transform((s) => new Date(s))
    .refine((d) => d.getTime() > Date.now() - 60_000, 'Send time is in the past')
    .refine((d) => d.getTime() < Date.now() + 366 * 24 * 60 * 60_000, 'Send time must be within a year'),
  timezone: z.string().refine(isTimeZone, 'Unknown timezone'),
});

type MessageInput = z.infer<typeof messageSchema>;

/** Recipients must be the user's own contacts (ban-risk policy). Returns jid -> name. */
async function resolveRecipients(client: pg.PoolClient, uid: string, jids: string[]) {
  const { rows } = await client.query<{ jid: string; name: string | null }>(
    'select jid, name from contacts where user_id = $1 and jid = any($2)',
    [uid, jids],
  );
  if (rows.length !== jids.length) throw new HttpError(400, 'Some recipients are not in your contacts');
  return rows;
}

async function insertRecipients(client: pg.PoolClient, messageId: string, rows: { jid: string; name: string | null }[]) {
  await client.query(
    `insert into message_recipients (scheduled_message_id, contact_jid, display_name)
     select $1, * from unnest($2::text[], $3::text[])`,
    [messageId, rows.map((r) => r.jid), rows.map((r) => r.name)],
  );
}

async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

// Prefer the contact's current name; the snapshot covers contacts that were since removed.
const RECIPIENT_NAME = `coalesce(c.name, r.display_name)`;
const RECIPIENT_JOIN = `left join contacts c on c.user_id = m.user_id and c.jid = r.contact_jid`;

const LIST_COLUMNS = `
  m.id, m.body, m.send_at as "sendAt", m.timezone, m.status, m.last_error as "lastError",
  (select coalesce(json_agg(coalesce(${RECIPIENT_NAME}, '+' || split_part(r.contact_jid, '@', 1))
                            order by ${RECIPIENT_NAME} nulls last), '[]')
     from message_recipients r ${RECIPIENT_JOIN}
     where r.scheduled_message_id = m.id) as recipients`;

messagesRouter.get('/', async (req, res) => {
  const upcoming = req.query.filter !== 'history';
  const { rows } = await pool.query(
    `select ${LIST_COLUMNS} from scheduled_messages m
     where m.user_id = $1 and (m.status = any($2)) = $3
     order by m.send_at ${upcoming ? 'asc' : 'desc'}
     limit 200`,
    [userId(res), UPCOMING, upcoming],
  );
  res.json(rows);
});

messagesRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`select ${LIST_COLUMNS} from scheduled_messages m where m.id = $1 and m.user_id = $2`, [
    req.params.id,
    userId(res),
  ]);
  if (!rows[0]) return void res.status(404).json({ error: 'Not found' });

  const { rows: recipients } = await pool.query(
    `select r.contact_jid as jid, ${RECIPIENT_NAME} as name, d.status, d.error, d.updated_at as "updatedAt"
     from message_recipients r
     join scheduled_messages m on m.id = r.scheduled_message_id
     ${RECIPIENT_JOIN}
     left join lateral (
       select status, error, updated_at from deliveries where recipient_id = r.id order by created_at desc limit 1
     ) d on true
     where r.scheduled_message_id = $1
     order by 2 nulls last, r.contact_jid`,
    [req.params.id],
  );
  res.json({ ...rows[0], deliveries: recipients });
});

messagesRouter.post('/', async (req, res) => {
  const parsed = messageSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0].message });
  const input: MessageInput = parsed.data;
  const uid = userId(res);

  const id = await inTransaction(async (client) => {
    const recipients = await resolveRecipients(client, uid, input.recipients);
    const { rows } = await client.query<{ id: string }>(
      `insert into scheduled_messages (user_id, body, send_at, timezone) values ($1, $2, $3, $4) returning id`,
      [uid, input.body, input.sendAt, input.timezone],
    );
    await insertRecipients(client, rows[0].id, recipients);
    return rows[0].id;
  });

  wakeScheduler();
  res.status(201).json({ id });
});

messagesRouter.patch('/:id', async (req, res) => {
  const parsed = messageSchema.partial().safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0].message });
  const input = parsed.data;
  const uid = userId(res);

  await inTransaction(async (client) => {
    const { rows } = await client.query<{ status: string; send_at: Date }>(
      'select status, send_at from scheduled_messages where id = $1 and user_id = $2 for update',
      [req.params.id, uid],
    );
    if (!rows[0]) throw new HttpError(404, 'Not found');
    if (!EDITABLE.includes(rows[0].status)) throw new HttpError(409, `A ${rows[0].status} message can't be edited`);

    if (input.recipients) {
      const recipients = await resolveRecipients(client, uid, input.recipients);
      await client.query('delete from message_recipients where scheduled_message_id = $1', [req.params.id]);
      await insertRecipients(client, req.params.id, recipients);
    }
    await client.query(
      `update scheduled_messages set
         body = coalesce($2, body), send_at = coalesce($3, send_at), timezone = coalesce($4, timezone),
         status = 'scheduled', last_error = null, attempts = 0, next_attempt_at = null, updated_at = now()
       where id = $1`,
      [req.params.id, input.body ?? null, input.sendAt ?? null, input.timezone ?? null],
    );
  });

  wakeScheduler();
  res.json({ ok: true });
});

messagesRouter.post('/:id/send-now', async (req, res) => {
  const { rowCount } = await pool.query(
    `update scheduled_messages set send_at = now(), status = 'scheduled', last_error = null,
       attempts = 0, next_attempt_at = null, updated_at = now()
     where id = $1 and user_id = $2 and status = any($3)`,
    [req.params.id, userId(res), EDITABLE],
  );
  if (!rowCount) return void res.status(409).json({ error: "This message can't be sent now" });
  wakeScheduler();
  res.json({ ok: true });
});

messagesRouter.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query(
    `update scheduled_messages set status = 'cancelled', updated_at = now()
     where id = $1 and user_id = $2 and status = any($3)`,
    [req.params.id, userId(res), CANCELLABLE],
  );
  // A message mid-send stops before its next recipient (the sender's heartbeat sees the cancel).
  if (!rowCount) return void res.status(409).json({ error: "This message can't be cancelled" });
  res.json({ ok: true });
});

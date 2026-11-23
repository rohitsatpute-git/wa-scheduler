import { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireAuth, userId } from '../auth.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError } from '../errors.js';
import { wakeScheduler } from '../scheduler.js';
import { createNext, nextOccurrence } from '../series.js';
import { needsNote, SuggestOptions } from '../suggest.js';
import { inTransaction, isTimeZone, resolveRecipients } from './messages.js';

export const seriesRouter = Router();
seriesRouter.use(requireAuth);
seriesRouter.param('id', (_req, res, next, id: string) => {
  if (!z.uuid().safeParse(id).success) return void res.status(404).json({ error: 'Not found' });
  next();
});

const MAX_BODIES = 100;

const seriesSchema = z
  .object({
    recipients: z
      .array(z.string())
      .min(1, 'Pick at least one recipient')
      .max(config.maxRecipients, `At most ${config.maxRecipients} recipients per message`)
      .transform((r) => [...new Set(r)]),
    timezone: z.string().refine(isTimeZone, 'Unknown timezone'),
    /** First send: its local date is the start date and its local time is the time of every send. */
    startAt: z.iso
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .refine((d) => d.getTime() > Date.now() - 60_000, 'Start time is in the past')
      .refine((d) => d.getTime() < Date.now() + 366 * 24 * 60 * 60_000, 'Start time must be within a year'),
    /** Days of the week, 0 = Sunday. */
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1, 'Pick at least one day')
      .transform((d) => [...new Set(d)].sort()),
    endsOn: z.iso.date().nullish(),
    maxCount: z.number().int().min(1).max(1000).nullish(),
    mode: z.enum(['list', 'ai']),
    bodies: z
      .array(z.string().trim().max(4096))
      .max(MAX_BODIES, `At most ${MAX_BODIES} messages`)
      .default([])
      .transform((b) => b.filter(Boolean)),
    ai: SuggestOptions.omit({ recipientName: true }).nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'list' && v.bodies.length === 0) ctx.addIssue({ code: 'custom', message: 'Message is empty' });
    if (v.mode === 'ai' && !v.ai) ctx.addIssue({ code: 'custom', message: 'Choose what the AI should write' });
    if (v.mode === 'ai' && v.ai && !needsNote(v.ai))
      ctx.addIssue({ code: 'custom', message: 'Describe the message you want the AI to write' });
  });

type SeriesInput = z.infer<typeof seriesSchema>;

const SERIES_COLUMNS = `
  s.id, s.days, to_char(s.time_of_day, 'HH24:MI') as "timeOfDay", s.timezone,
  to_char(s.starts_on, 'YYYY-MM-DD') as "startsOn", to_char(s.ends_on, 'YYYY-MM-DD') as "endsOn",
  s.max_count as "maxCount", s.body_mode as mode, s.bodies, s.ai_options as ai, s.status,
  (select coalesce(json_agg(json_build_object('jid', r.contact_jid, 'name', coalesce(c.name, r.display_name))
                            order by coalesce(c.name, r.display_name) nulls last), '[]')
     from series_recipients r left join contacts c on c.user_id = s.user_id and c.jid = r.contact_jid
    where r.series_id = s.id) as recipients,
  (select json_build_object('id', m.id, 'sendAt', m.send_at, 'body', m.body)
     from scheduled_messages m where m.series_id = s.id and m.status in ('scheduled', 'retrying')
    order by m.send_at limit 1) as next,
  (select count(*)::int from scheduled_messages m
    where m.series_id = s.id and m.status in ('done', 'partial')) as "sentCount"`;

seriesRouter.get('/', async (_req, res) => {
  const { rows } = await pool.query(
    `select ${SERIES_COLUMNS} from message_series s where s.user_id = $1
      order by (s.status = 'active') desc, s.created_at desc limit 200`,
    [userId(res)],
  );
  res.json(rows);
});

seriesRouter.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`select ${SERIES_COLUMNS} from message_series s where s.id = $1 and s.user_id = $2`, [
    req.params.id,
    userId(res),
  ]);
  if (!rows[0]) throw new HttpError(404, 'Not found');
  res.json(rows[0]);
});

/** Insert or update the series row and its recipients. Returns the series id. */
async function save(client: pg.PoolClient, uid: string, input: SeriesInput, id?: string) {
  const recipients = await resolveRecipients(client, uid, input.recipients);
  const values = [
    input.days,
    input.startAt,
    input.timezone,
    input.endsOn ?? null,
    input.maxCount ?? null,
    input.mode,
    input.mode === 'list' ? input.bodies : [],
    input.mode === 'ai' ? JSON.stringify(input.ai) : null,
  ];
  let seriesId = id;
  if (seriesId) {
    const { rowCount } = await client.query(
      `update message_series set
         days = $1, time_of_day = ($2::timestamptz at time zone $3)::time, timezone = $3,
         starts_on = ($2::timestamptz at time zone $3)::date, ends_on = $4, max_count = $5,
         body_mode = $6, bodies = $7, ai_options = $8, status = 'active', updated_at = now()
       where id = $9 and user_id = $10`,
      [...values, seriesId, uid],
    );
    if (!rowCount) throw new HttpError(404, 'Not found');
    // The upcoming send is rebuilt from the new settings; sent and sending ones stay as they were.
    await client.query(
      `delete from scheduled_messages where series_id = $1 and status in ('scheduled', 'retrying')`,
      [seriesId],
    );
    await client.query('delete from series_recipients where series_id = $1', [seriesId]);
  } else {
    const { rows } = await client.query<{ id: string }>(
      `insert into message_series (user_id, days, time_of_day, timezone, starts_on, ends_on, max_count, body_mode, bodies, ai_options)
       values ($9, $1, ($2::timestamptz at time zone $3)::time, $3, ($2::timestamptz at time zone $3)::date, $4, $5, $6, $7, $8)
       returning id`,
      [...values, uid],
    );
    seriesId = rows[0].id;
  }
  await client.query(
    `insert into series_recipients (series_id, contact_jid, display_name)
     select $1, * from unnest($2::text[], $3::text[])`,
    [seriesId, recipients.map((r) => r.jid), recipients.map((r) => r.name)],
  );
  if (!(await nextOccurrence(client, seriesId, new Date(Date.now() - 60_000)))) {
    throw new HttpError(400, 'None of the chosen days fall between the start and end dates');
  }
  return seriesId;
}

async function scheduleFirst(seriesId: string) {
  const { rows } = await pool.query(
    `select id, user_id, timezone, max_count, body_mode, bodies, ai_options from message_series where id = $1`,
    [seriesId],
  );
  const firstId = await createNext(rows[0]);
  wakeScheduler();
  return firstId;
}

seriesRouter.post('/', async (req, res) => {
  const parsed = seriesSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
  const uid = userId(res);
  const id = await inTransaction((client) => save(client, uid, parsed.data));
  res.status(201).json({ id, firstMessageId: await scheduleFirst(id) });
});

seriesRouter.put('/:id', async (req, res) => {
  const parsed = seriesSchema.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
  const uid = userId(res);
  const id = await inTransaction((client) => save(client, uid, parsed.data, req.params.id));
  res.json({ id, firstMessageId: await scheduleFirst(id) });
});

/** Stop repeating: cancels the upcoming send. Past sends stay in history. */
seriesRouter.post('/:id/stop', async (req, res) => {
  const uid = userId(res);
  await inTransaction(async (client) => {
    const { rowCount } = await client.query(
      `update message_series set status = 'stopped', updated_at = now() where id = $1 and user_id = $2`,
      [req.params.id, uid],
    );
    if (!rowCount) throw new HttpError(404, 'Not found');
    await client.query(
      `update scheduled_messages set status = 'cancelled', updated_at = now()
        where series_id = $1 and status in ('scheduled', 'retrying')`,
      [req.params.id],
    );
  });
  res.json({ ok: true });
});

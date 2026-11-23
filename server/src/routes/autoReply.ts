import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, userId } from '../auth.js';
import { autoReplyAvailable, autoReplyLimits, forgetChat } from '../autoReply.js';
import { pool } from '../db.js';

export const autoReplyRouter = Router();
autoReplyRouter.use(requireAuth);

autoReplyRouter.get('/', async (_req, res) => {
  const uid = userId(res);
  const [settings, contacts, recent] = await Promise.all([
    pool.query<{ enabled: boolean; instructions: string }>(
      'select enabled, instructions from auto_reply_settings where user_id = $1',
      [uid],
    ),
    pool.query(
      `select jid, name from contacts where user_id = $1 and auto_reply order by name nulls last, jid`,
      [uid],
    ),
    pool.query(
      `select m.chat_jid as "jid", c.name, m.text, m.sent_at as "sentAt"
         from chat_messages m left join contacts c on c.user_id = m.user_id and c.jid = m.chat_jid
        where m.user_id = $1 and m.source = 'ai'
        order by m.sent_at desc limit 20`,
      [uid],
    ),
  ]);
  res.json({
    available: autoReplyAvailable,
    enabled: settings.rows[0]?.enabled ?? false,
    instructions: settings.rows[0]?.instructions ?? '',
    contacts: contacts.rows,
    recent: recent.rows,
  });
});

/** Dashboard: per-contact usage against the limits, hourly volume and recent activity. */
autoReplyRouter.get('/stats', async (_req, res) => {
  const uid = userId(res);
  const { perChatPerHour, handoffMinutes } = autoReplyLimits;
  const [settings, contacts, hourly, activity] = await Promise.all([
    pool.query<{ enabled: boolean }>('select enabled from auto_reply_settings where user_id = $1', [uid]),
    pool.query(
      `with recent_ai as (
         select chat_jid, sent_at, row_number() over (partition by chat_jid order by sent_at desc) as rn
           from chat_messages where user_id = $1 and source = 'ai' and sent_at > now() - interval '1 hour'
       )
       select c.jid, c.name,
         (select count(*)::int from recent_ai r where r.chat_jid = c.jid) as "repliesLastHour",
         -- With the chat at its limit, a slot frees when the limit-th newest reply turns an hour old.
         (select r.sent_at + interval '1 hour' from recent_ai r where r.chat_jid = c.jid and r.rn = $2) as "limitFreesAt",
         (select max(m.sent_at) + make_interval(mins => $3) from chat_messages m
           where m.user_id = $1 and m.chat_jid = c.jid and m.source = 'me'
          having max(m.sent_at) + make_interval(mins => $3) > now()) as "handoffUntil",
         (select count(*)::int from chat_messages m where m.user_id = $1 and m.chat_jid = c.jid
            and m.source = 'contact' and m.sent_at > now() - interval '24 hours') as "received24h",
         (select count(*)::int from chat_messages m where m.user_id = $1 and m.chat_jid = c.jid
            and m.source = 'ai' and m.sent_at > now() - interval '24 hours') as "replies24h",
         (select count(*)::int from auto_reply_skips s where s.user_id = $1 and s.chat_jid = c.jid
            and s.created_at > now() - interval '24 hours') as "skipped24h",
         (select max(m.sent_at) from chat_messages m where m.user_id = $1 and m.chat_jid = c.jid
            and m.source = 'contact') as "lastMessageAt"
       from contacts c where c.user_id = $1 and c.auto_reply
       order by "lastMessageAt" desc nulls last, c.name nulls last, c.jid`,
      [uid, perChatPerHour, handoffMinutes],
    ),
    pool.query(
      `select h as "hour",
         (select count(*)::int from chat_messages m where m.user_id = $1 and m.source = 'ai'
            and m.sent_at >= h and m.sent_at < h + interval '1 hour') as replies,
         (select count(*)::int from auto_reply_skips s where s.user_id = $1
            and s.created_at >= h and s.created_at < h + interval '1 hour') as skipped
       from generate_series(date_trunc('hour', now()) - interval '23 hours', date_trunc('hour', now()), interval '1 hour') h
       order by h`,
      [uid],
    ),
    pool.query(
      `select a.type, a.reason, a.jid, c.name, a.text, a.at from (
         select 'sent' as type, null as reason, m.chat_jid as jid, m.text, m.sent_at as at
           from chat_messages m where m.user_id = $1 and m.source = 'ai'
         union all
         -- For a skip, show the contact message it stayed silent on.
         select 'skipped', s.reason, s.chat_jid,
           (select m.text from chat_messages m where m.user_id = s.user_id and m.chat_jid = s.chat_jid
              and m.source = 'contact' and m.sent_at <= s.created_at order by m.sent_at desc limit 1),
           s.created_at
           from auto_reply_skips s where s.user_id = $1
       ) a left join contacts c on c.user_id = $1 and c.jid = a.jid
       order by a.at desc limit 40`,
      [uid],
    ),
  ]);
  res.json({
    available: autoReplyAvailable,
    enabled: settings.rows[0]?.enabled ?? false,
    limits: autoReplyLimits,
    contacts: contacts.rows,
    hourly: hourly.rows,
    activity: activity.rows,
  });
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  instructions: z.string().max(2000, 'Keep instructions under 2000 characters').optional(),
});

autoReplyRouter.put('/', async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0].message });
  await pool.query(
    `insert into auto_reply_settings (user_id, enabled, instructions) values ($1, coalesce($2, false), coalesce($3, ''))
     on conflict (user_id) do update set
       enabled = coalesce($2, auto_reply_settings.enabled),
       instructions = coalesce($3, auto_reply_settings.instructions),
       updated_at = now()`,
    [userId(res), parsed.data.enabled ?? null, parsed.data.instructions ?? null],
  );
  res.json({ ok: true });
});

autoReplyRouter.put('/contacts/:jid', async (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Send { enabled: true | false }' });
  const jid = req.params.jid;
  // Incoming chats are matched by phone-number JID, so only those can be switched on.
  if (!jid.endsWith('@s.whatsapp.net')) {
    return void res.status(400).json({ error: 'Auto-reply works for individual contacts only' });
  }
  const uid = userId(res);
  const { rowCount } = await pool.query('update contacts set auto_reply = $3 where user_id = $1 and jid = $2', [
    uid,
    jid,
    parsed.data.enabled,
  ]);
  if (!rowCount) return void res.status(404).json({ error: 'Contact not found' });
  if (!parsed.data.enabled) await forgetChat(uid, jid);
  res.json({ ok: true });
});

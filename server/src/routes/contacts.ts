import { Router } from 'express';
import { z } from 'zod';
import { rateLimit, requireAuth, userId } from '../auth.js';
import { pool } from '../db.js';
import { sessions } from '../wa/sessionManager.js';

export const contactsRouter = Router();
contactsRouter.use(requireAuth);

contactsRouter.get('/', async (req, res) => {
  const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  const digits = search.replace(/\D/g, '');
  const { rows } = await pool.query(
    `select jid, name, is_group as "isGroup", manual from contacts
     where user_id = $1
       and ($2 = '' or name ilike '%' || $2 || '%' or ($3 <> '' and jid like '%' || $3 || '%'))
     order by is_group desc, name nulls last, jid
     limit 200`,
    [userId(res), search, digits],
  );
  res.json(rows);
});

contactsRouter.post('/resync', rateLimit(3, 10 * 60_000), async (_req, res) => {
  const ok = await sessions.resyncContacts(userId(res));
  if (!ok) return void res.status(409).json({ error: 'Connect WhatsApp first' });
  res.json({ ok: true });
});

const addSchema = z.object({
  phone: z
    .string()
    .transform((s) => s.replace(/\D/g, ''))
    .pipe(z.string().min(8, 'Include the country code').max(15)),
  name: z.string().trim().max(100).optional(),
});

contactsRouter.post('/', async (req, res) => {
  const parsed = addSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0].message });

  const sock = sessions.getSocket(userId(res));
  if (!sock) return void res.status(409).json({ error: 'Connect WhatsApp first' });

  const [result] = (await sock.onWhatsApp(parsed.data.phone)) ?? [];
  if (!result?.exists) return void res.status(400).json({ error: 'That number is not on WhatsApp' });

  const { rows } = await pool.query(
    // A name typed here outranks anything synced from WhatsApp (rank 4).
    `insert into contacts (user_id, jid, name, name_rank, manual) values ($1, $2, $3, $4, true)
     on conflict (user_id, jid) do update set
       name = case when excluded.name_rank >= contacts.name_rank then excluded.name else contacts.name end,
       name_rank = greatest(contacts.name_rank, excluded.name_rank),
       updated_at = now()
     returning jid, name, is_group as "isGroup", manual`,
    [userId(res), result.jid, parsed.data.name || null, parsed.data.name ? 4 : 0],
  );
  res.status(201).json(rows[0]);
});

import { Router } from 'express';
import { z } from 'zod';
import { clearAuthCookie, rateLimit, requireAuth, setAuthCookie, signToken, userId } from '../auth.js';
import { pool } from '../db.js';
import { sessions } from '../wa/sessionManager.js';

export const authRouter = Router();

const startSchema = z.object({
  acceptTos: z.literal(true, { error: 'You must accept the risk notice to continue' }),
  // Pairing-code login: digits only, with country code.
  phone: z
    .string()
    .transform((s) => s.replace(/\D/g, ''))
    .pipe(z.string().min(8).max(15))
    .optional(),
});

authRouter.post('/link/start', rateLimit(5, 60_000), async (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.issues[0].message });
  const link = await sessions.startLink(parsed.data.phone);
  res.json(link);
});

const completeSchema = z.object({
  linkId: z.uuid(),
  secret: z.string().min(1),
  // The Android app can't use the cookie; it gets the token in the response instead.
  client: z.enum(['web', 'app']).default('web'),
});

authRouter.post('/link/complete', rateLimit(20, 60_000), async (req, res) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: 'Invalid link' });
  const id = sessions.completeLink(parsed.data.linkId, parsed.data.secret);
  if (!id) return void res.status(400).json({ error: 'Link is not complete or has expired' });
  if (parsed.data.client === 'app') return void res.json({ ok: true, token: signToken(id) });
  setAuthCookie(res, id);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (_req, res) => {
  const { rows } = await pool.query('select id, wa_jid, display_name from users where id = $1', [userId(res)]);
  if (!rows[0]) {
    clearAuthCookie(res);
    return void res.status(401).json({ error: 'Not signed in' });
  }
  const user = rows[0];
  res.json({
    user: { id: user.id, phone: user.wa_jid.split('@')[0], name: user.display_name },
    whatsapp: { status: await sessions.getStatus(user.id) },
  });
});

/**
 * Delete the account: unlink WhatsApp, then remove the user and everything that hangs off it
 * (contacts, messages, repeats, auto-reply data) via ON DELETE CASCADE. Required by Google Play.
 */
authRouter.delete('/account', requireAuth, async (_req, res) => {
  const uid = userId(res);
  await sessions.logout(uid).catch(() => {});
  await pool.query('delete from users where id = $1', [uid]);
  clearAuthCookie(res);
  res.json({ ok: true });
});

authRouter.post('/logout', requireAuth, async (_req, res) => {
  await sessions.logout(userId(res));
  clearAuthCookie(res);
  res.json({ ok: true });
});

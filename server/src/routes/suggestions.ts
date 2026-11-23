import { Router } from 'express';
import { requireAuth, userId } from '../auth.js';
import { HttpError } from '../errors.js';
import { aiSuggestAvailable, suggestMessages, SuggestInput } from '../suggest.js';

export const suggestionsRouter = Router();
suggestionsRouter.use(requireAuth);

// Each click is one AI call, so cap it per user.
const LIMIT = 40;
const WINDOW_MS = 60 * 60_000;
const hits = new Map<string, { count: number; resetAt: number }>();

function allow(uid: string) {
  const now = Date.now();
  const entry = hits.get(uid);
  if (!entry || entry.resetAt < now) {
    hits.set(uid, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  return ++entry.count <= LIMIT;
}

suggestionsRouter.get('/', (_req, res) => void res.json({ ai: aiSuggestAvailable }));

suggestionsRouter.post('/', async (req, res) => {
  const parsed = SuggestInput.safeParse(req.body);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? 'Invalid input');
  if (!allow(userId(res))) throw new HttpError(429, 'Too many suggestions for now. Try again in a bit.');
  res.json(await suggestMessages(parsed.data));
});

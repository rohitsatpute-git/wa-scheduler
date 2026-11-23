import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { appCors, requireJsonOnWrites } from './auth.js';
import { privacyPage } from './privacy.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';
import { attachRealtime } from './realtime.js';
import { startAutoReply, stopAutoReply } from './autoReply.js';
import { authRouter } from './routes/auth.js';
import { autoReplyRouter } from './routes/autoReply.js';
import { contactsRouter } from './routes/contacts.js';
import { messagesRouter } from './routes/messages.js';
import { seriesRouter } from './routes/series.js';
import { suggestionsRouter } from './routes/suggestions.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { sessions } from './wa/sessionManager.js';

await migrate();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const api = express.Router();
api.use(appCors);
api.use(requireJsonOnWrites);
api.get('/health', (_req, res) => void res.json({ ok: true }));
api.use('/auth', authRouter);
api.use('/contacts', contactsRouter);
api.use('/messages', messagesRouter);
api.use('/auto-reply', autoReplyRouter);
api.use('/suggestions', suggestionsRouter);
api.use('/series', seriesRouter);
api.use((_req, res) => void res.status(404).json({ error: 'Not found' }));
app.use('/api', api);

// Public pages for the Play Store listing (privacy policy, how to delete your account).
app.get('/privacy', privacyPage);

// In production, serve the built web app from the same origin.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get('/{*path}', (_req, res) => res.sendFile('index.html', { root: webDist }));
}

app.use(errorHandler);

const server = createServer(app);
attachRealtime(server);

await sessions.restoreAll();
await startScheduler();
startAutoReply();

server.listen(config.port, () => logger.info(`server listening on http://localhost:${config.port}`));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await stopScheduler();
  stopAutoReply();
  await sessions.shutdown();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

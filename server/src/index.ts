import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express from 'express';
import { requireJsonOnWrites } from './auth.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';
import { attachRealtime } from './realtime.js';
import { authRouter } from './routes/auth.js';
import { contactsRouter } from './routes/contacts.js';
import { messagesRouter } from './routes/messages.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { sessions } from './wa/sessionManager.js';

await migrate();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

const api = express.Router();
api.use(requireJsonOnWrites);
api.get('/health', (_req, res) => void res.json({ ok: true }));
api.use('/auth', authRouter);
api.use('/contacts', contactsRouter);
api.use('/messages', messagesRouter);
api.use((_req, res) => void res.status(404).json({ error: 'Not found' }));
app.use('/api', api);

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

server.listen(config.port, () => logger.info(`server listening on http://localhost:${config.port}`));

async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');
  server.close();
  await stopScheduler();
  await sessions.shutdown();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

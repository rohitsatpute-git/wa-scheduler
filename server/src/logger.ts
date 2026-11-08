import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  transport: config.isProd ? undefined : { target: 'pino-pretty', options: { colorize: true } },
});

// Baileys logs a lot at info level; keep it quiet unless something goes wrong.
export const waLogger = logger.child({ module: 'baileys' }, { level: 'warn' });

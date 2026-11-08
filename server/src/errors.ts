import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger.js';

/** Throw from a route to send `{ error: message }` with this status. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  if (err instanceof SyntaxError && 'body' in err) return void res.status(400).json({ error: 'Invalid JSON' });
  logger.error({ err, method: req.method, url: req.originalUrl }, 'request failed');
  res.status(500).json({ error: 'Something went wrong' });
}

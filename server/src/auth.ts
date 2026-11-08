import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from './config.js';

export const COOKIE = 'wa_token';
const MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export function signToken(userId: string) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: Math.floor(MAX_AGE_MS / 1000) });
}

export function verifyToken(token: string | undefined): string | null {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return typeof payload === 'object' && typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

export function setAuthCookie(res: Response, userId: string) {
  res.cookie(COOKIE, signToken(userId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: MAX_AGE_MS,
  });
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: config.isProd });
}

export function userId(res: Response): string {
  return res.locals.userId as string;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const id = verifyToken(req.cookies?.[COOKIE]);
  if (!id) return void res.status(401).json({ error: 'Not signed in' });
  res.locals.userId = id;
  next();
}

/**
 * CSRF defence for cookie auth: SameSite=Lax cookies plus requiring a JSON body on writes,
 * which a cross-site HTML form cannot send.
 */
export function requireJsonOnWrites(req: Request, res: Response, next: NextFunction) {
  const json = req.headers['content-type']?.toLowerCase().startsWith('application/json');
  if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) && !json) {
    return void res.status(415).json({ error: 'Content-Type must be application/json' });
  }
  next();
}

/** Small fixed-window limiter, per IP. Fine for one process; use Redis once there are several. */
export function rateLimit(limit: number, windowMs: number) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (++entry.count > limit) return void res.status(429).json({ error: 'Too many requests, try again shortly' });
    next();
  };
}

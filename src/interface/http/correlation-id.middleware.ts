import type { NextFunction, Request, Response } from 'express';
import { uuidv7 } from 'uuidv7';

const VALID = /^[\x21-\x7E]{1,128}$/;
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Accepts a caller-provided `X-Correlation-Id` (printable, ≤128 chars) or
 * generates one, normalises it into the request headers (so the pino-http
 * request id and every log line share it) and echoes it on the response.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers[CORRELATION_HEADER];
  const id = typeof incoming === 'string' && VALID.test(incoming) ? incoming : uuidv7();
  req.headers[CORRELATION_HEADER] = id;
  res.setHeader('X-Correlation-Id', id);
  next();
}

export function correlationIdOf(req: Request): string {
  const v = req.headers[CORRELATION_HEADER];
  return typeof v === 'string' ? v : 'unknown';
}

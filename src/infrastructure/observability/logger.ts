import pino, { type Logger } from 'pino';
import type { LoggerPort } from '../../application/ports/system';

/**
 * Never log financial payloads: request/response bodies, raw messages and
 * monetary fields are redacted wherever they appear.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'body',
  '*.body',
  'payload',
  '*.payload',
  'money',
  '*.money',
  'balance',
  '*.balance',
  'amount',
  '*.amount',
  'balanceBefore',
  '*.balanceBefore',
  'balanceAfter',
  '*.balanceAfter',
  'initialBalance',
  '*.initialBalance',
];

export function createRootLogger(opts: { level: string; instanceId: string }): Logger {
  return pino({
    level: opts.level,
    base: { service: 'wagering', instanceId: opts.instanceId },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
  });
}

/** Adapts pino to the application's LoggerPort (structured JSON, child bindings for ids). */
export class PinoLoggerAdapter implements LoggerPort {
  constructor(private readonly logger: Logger) {}

  child(bindings: Record<string, unknown>): LoggerPort {
    return new PinoLoggerAdapter(this.logger.child(bindings));
  }
  debug(obj: object, msg: string): void {
    this.logger.debug(obj, msg);
  }
  info(obj: object, msg: string): void {
    this.logger.info(obj, msg);
  }
  warn(obj: object, msg: string): void {
    this.logger.warn(obj, msg);
  }
  error(obj: object, msg: string): void {
    this.logger.error(obj, msg);
  }
}

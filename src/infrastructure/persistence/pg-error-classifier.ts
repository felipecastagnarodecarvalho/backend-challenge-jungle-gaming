import {
  ApplicationError,
  IntegrityViolationError,
  TransientDatabaseError,
  type TransientReason,
  UniqueViolationError,
} from '../../application/errors';

interface PgLikeError {
  code?: unknown;
  constraint?: unknown;
  detail?: unknown;
  message?: unknown;
  cause?: unknown;
}

const SQLSTATE_TRANSIENT: Record<string, TransientReason> = {
  '40001': 'serialization',
  '40P01': 'deadlock',
  '55P03': 'lock_timeout',
  '57014': 'statement_timeout',
  '57P01': 'connection',
  '57P02': 'connection',
  '57P03': 'connection',
  '53300': 'connection',
  '53400': 'connection',
};

const SOCKET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']);
const POOL_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated',
  'Client has encountered a connection error',
  'connection is closed',
];

/** Finds the first error in the `cause` chain that carries a string `code` (SQLSTATE or errno). */
function findCoded(err: unknown): PgLikeError | undefined {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as PgLikeError;
    if (typeof candidate.code === 'string') return candidate;
    current = candidate.cause;
  }
  return undefined;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Translates driver errors into application errors **by SQLSTATE**, never by
 * `instanceof` (MikroORM surfaces e.g. lock_timeout as a generic
 * DriverException). Transient → retried; 23505 → unique violation with the
 * constraint name; other 23xxx (CHECK/FK/trigger) → permanent integrity error.
 * Unknown errors are returned unchanged.
 */
export function classifyDatabaseError(err: unknown): unknown {
  if (err instanceof ApplicationError) return err;
  const coded = findCoded(err);
  const code = typeof coded?.code === 'string' ? coded.code : undefined;
  if (code) {
    const transient = SQLSTATE_TRANSIENT[code];
    if (transient) return new TransientDatabaseError(transient, { cause: err });
    if (code.startsWith('08')) return new TransientDatabaseError('connection', { cause: err });
    if (SOCKET_CODES.has(code)) return new TransientDatabaseError('connection', { cause: err });
    if (code === '23505') {
      return new UniqueViolationError(typeof coded?.constraint === 'string' ? coded.constraint : undefined, {
        cause: err,
      });
    }
    if (code.startsWith('23')) {
      const constraint = typeof coded?.constraint === 'string' ? coded.constraint : undefined;
      return new IntegrityViolationError(messageOf(coded ?? err), constraint, { cause: err });
    }
  }
  const message = messageOf(err);
  if (POOL_MESSAGES.some((m) => message.includes(m))) {
    return new TransientDatabaseError('connection', { cause: err });
  }
  return err;
}

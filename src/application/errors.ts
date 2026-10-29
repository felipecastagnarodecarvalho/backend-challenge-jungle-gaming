/**
 * Application-level errors. Business outcomes (idempotency conflict, rejection,
 * wallet not found on submission) are *results*, not exceptions; exceptions
 * are reserved for invalid input, infrastructure trouble and bugs.
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface ValidationIssue {
  path: string;
  message: string;
}

/** Invalid payload (schema or domain validation). HTTP 400 / SQS poison. */
export class ValidationError extends ApplicationError {
  readonly code = 'VALIDATION_ERROR';
  constructor(
    readonly details: ValidationIssue[],
    message = 'Invalid request payload',
  ) {
    super(message);
  }
}

export type NotFoundCode = 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND';

export class NotFoundError extends ApplicationError {
  constructor(
    readonly code: NotFoundCode,
    message = 'Resource not found',
  ) {
    super(message);
  }
}

export class InvalidCursorError extends ApplicationError {
  readonly code = 'INVALID_CURSOR';
  constructor() {
    super('Invalid ledger cursor');
  }
}

export class WalletAlreadyExistsError extends ApplicationError {
  readonly code = 'WALLET_ALREADY_EXISTS';
  constructor() {
    super('A wallet already exists for this player and currency');
  }
}

export type TransientReason =
  | 'serialization'
  | 'deadlock'
  | 'lock_timeout'
  | 'statement_timeout'
  | 'connection'
  | 'idempotency_race'
  | 'unique_race'
  | 'broker'
  | 'injected';

/** Raw transient DB failure (classified by SQLSTATE). Retried by `withTransientRetry`. */
export class TransientDatabaseError extends ApplicationError {
  readonly code = 'TRANSIENT_DATABASE_ERROR';
  constructor(
    readonly reason: TransientReason,
    options?: { cause?: unknown },
  ) {
    super(`Transient database error (${reason})`, options);
  }
}

/** Transient failure after internal retries were exhausted. HTTP 503 / SQS visibility backoff. */
export class TransientInfrastructureError extends ApplicationError {
  readonly code = 'TRANSIENT_FAILURE';
  constructor(
    readonly reason: TransientReason | string,
    options?: { cause?: unknown },
  ) {
    super(`Transient infrastructure failure (${reason})`, options);
  }
}

/** SQLSTATE 23505, carrying the violated constraint name. */
export class UniqueViolationError extends ApplicationError {
  readonly code = 'UNIQUE_VIOLATION';
  constructor(
    readonly constraint: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`Unique constraint violated (${constraint ?? 'unknown'})`, options);
  }
}

/** Any other 23xxx (CHECK, FK, integrity trigger): a schema guard caught a bug. Permanent. */
export class IntegrityViolationError extends ApplicationError {
  readonly code = 'INTEGRITY_VIOLATION';
  constructor(
    readonly detail: string,
    readonly constraint?: string,
    options?: { cause?: unknown },
  ) {
    super(`Integrity violation: ${detail}`, options);
  }
}

/** A guarded UPDATE under lock affected != 1 rows: should be impossible (bug). */
export class ConcurrencyInvariantError extends ApplicationError {
  readonly code = 'CONCURRENCY_INVARIANT';
}

/**
 * `INSERT … ON CONFLICT DO NOTHING` inserted nothing: a concurrent transaction
 * with the same idempotency identity committed first. Rolled back and retried;
 * the next attempt resolves to replay/conflict deterministically.
 */
export class IdempotencyRaceError extends ApplicationError {
  readonly code = 'IDEMPOTENCY_RACE';
  constructor() {
    super('Concurrent insert of the same idempotency identity');
  }
}

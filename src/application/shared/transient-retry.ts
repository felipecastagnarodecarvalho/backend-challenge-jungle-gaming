import {
  IdempotencyRaceError,
  TransientDatabaseError,
  TransientInfrastructureError,
  type TransientReason,
  UniqueViolationError,
} from '../errors';
import type { MetricsPort } from '../ports/metrics';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Unique violations that represent a *race* with another transaction (not a
 * bug): on the next attempt the winner's row is visible and the outcome
 * becomes a deterministic replay / conflict / rejection.
 */
const RACE_CONSTRAINTS = new Set([
  'wager_tx_single_reversal_uk',
  'wager_tx_idempotency_key_uk',
  'wager_tx_provider_external_uk',
  'inbox_messages_pk',
]);

function retryReason(err: unknown): TransientReason | undefined {
  if (err instanceof TransientDatabaseError) return err.reason;
  if (err instanceof IdempotencyRaceError) return 'idempotency_race';
  if (err instanceof UniqueViolationError && err.constraint && RACE_CONSTRAINTS.has(err.constraint)) {
    return 'unique_race';
  }
  return undefined;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` (a whole unit of work — a fresh SQL transaction per attempt) and
 * retries only failures that are safe and likely to succeed on retry:
 * serialization/deadlock/lock-timeout/connection errors and idempotency races.
 * Business outcomes and permanent errors pass through untouched. After
 * `maxAttempts` it throws {@link TransientInfrastructureError} (HTTP 503 /
 * SQS visibility backoff), so the caller — not this loop — owns longer retries.
 */
export async function withTransientRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  metrics: MetricsPort,
  operation: string,
): Promise<T> {
  const base = policy.baseDelayMs ?? 25;
  const max = policy.maxDelayMs ?? 200;
  const jitter = policy.jitterMs ?? 25;
  const sleep = policy.sleep ?? defaultSleep;
  const random = policy.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const reason = retryReason(err);
      if (!reason) throw err;
      if (reason === 'lock_timeout' || reason === 'deadlock' || reason === 'serialization') {
        metrics.lockConflict(reason);
      }
      if (attempt >= policy.maxAttempts) {
        throw new TransientInfrastructureError(reason, { cause: err });
      }
      metrics.retry(operation, reason);
      await sleep(Math.min(base * 2 ** (attempt - 1), max) + Math.floor(random() * jitter));
    }
  }
}

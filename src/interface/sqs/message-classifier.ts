import { ConcurrencyInvariantError, IntegrityViolationError, ValidationError } from '../../application/errors';
import type { ProcessWagerResult } from '../../application/wager/wager-result';
import { DomainError } from '../../domain/shared/domain-error';
import { InvalidMessageError } from './sqs-envelope.schema';

export type MessageAction =
  | { action: 'ACK'; duplicate: boolean }
  | { action: 'RETRY'; reason: string }
  | { action: 'DLQ'; reason: 'invalid_payload' | 'permanent_error'; errorCode: string; errorMessage: string };

const dlq = (reason: 'invalid_payload' | 'permanent_error', errorCode: string, err: Error): MessageAction => ({
  action: 'DLQ',
  reason,
  errorCode,
  errorMessage: (err.message || errorCode).slice(0, 256),
});

/**
 * Decides what to do with a message after handling:
 * - business outcomes (processed, rejected, pending, conflict, unknown wallet,
 *   inbox duplicate) are terminal → ACK (delete);
 * - payloads that can never become valid → DLQ immediately (poison);
 * - errors that are *deterministically permanent* → DLQ immediately: a schema
 *   guard rejected the write (IntegrityViolationError: CHECK/FK/trigger, e.g. a
 *   corrupted wallet), a guarded update hit an impossible state under lock
 *   (ConcurrencyInvariantError) or a domain invariant broke (DomainError).
 *   All of these run under the wallet lock, so retrying the same message
 *   reproduces the same failure — retrying would only block the FIFO group;
 * - transient or unknown errors → RETRY with visibility backoff; the SQS
 *   redrive policy moves the message to the DLQ after maxReceiveCount. Unique
 *   violations outside the known races stay here on purpose (could be a race).
 */
export function classifyMessage(outcome: { result: ProcessWagerResult } | { error: unknown }): MessageAction {
  if ('result' in outcome) {
    const r = outcome.result;
    const duplicate = r.outcome === 'DUPLICATE_MESSAGE' || (r.outcome === 'TRANSACTION' && r.idempotentReplay);
    return { action: 'ACK', duplicate };
  }
  const err = outcome.error;
  if (err instanceof InvalidMessageError) return dlq('invalid_payload', 'INVALID_PAYLOAD', err);
  if (err instanceof ValidationError) return dlq('invalid_payload', 'VALIDATION_ERROR', err);
  if (
    err instanceof IntegrityViolationError ||
    err instanceof ConcurrencyInvariantError ||
    err instanceof DomainError
  ) {
    return dlq('permanent_error', err.code, err);
  }
  const reason =
    err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : 'unknown';
  return { action: 'RETRY', reason };
}

/** Visibility backoff for a retry: base·2^(receiveCount-1), capped. */
export function retryVisibilitySeconds(receiveCount: number, baseS: number, maxS: number): number {
  return Math.min(baseS * 2 ** Math.max(0, receiveCount - 1), maxS);
}

/** Heartbeat period: extend visibility at half the timeout, never more often than every second. */
export function heartbeatIntervalMs(visibilityTimeoutS: number): number {
  return Math.max(1, Math.floor(visibilityTimeoutS / 2)) * 1000;
}

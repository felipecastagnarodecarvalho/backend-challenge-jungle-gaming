import { ValidationError } from '../../application/errors';
import type { ProcessWagerResult } from '../../application/wager/wager-result';
import { InvalidMessageError } from './sqs-envelope.schema';

export type MessageAction =
  | { action: 'ACK'; duplicate: boolean }
  | { action: 'RETRY'; reason: string }
  | { action: 'DLQ'; reason: 'invalid_payload'; errorCode: string; errorMessage: string };

/**
 * Decides what to do with a message after handling:
 * - business outcomes (processed, rejected, pending, conflict, unknown wallet,
 *   inbox duplicate) are terminal → ACK (delete);
 * - payloads that can never become valid → DLQ immediately (poison);
 * - transient or unknown errors → RETRY with visibility backoff; the SQS
 *   redrive policy moves the message to the DLQ after maxReceiveCount.
 */
export function classifyMessage(outcome: { result: ProcessWagerResult } | { error: unknown }): MessageAction {
  if ('result' in outcome) {
    const r = outcome.result;
    const duplicate = r.outcome === 'DUPLICATE_MESSAGE' || (r.outcome === 'TRANSACTION' && r.idempotentReplay);
    return { action: 'ACK', duplicate };
  }
  const err = outcome.error;
  if (err instanceof InvalidMessageError || err instanceof ValidationError) {
    return {
      action: 'DLQ',
      reason: 'invalid_payload',
      errorCode: err instanceof ValidationError ? 'VALIDATION_ERROR' : 'INVALID_PAYLOAD',
      errorMessage: (err.message || 'invalid payload').slice(0, 256),
    };
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

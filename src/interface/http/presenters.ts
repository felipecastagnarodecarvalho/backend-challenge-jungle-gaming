import type { ProcessWagerResult, TransactionResult } from '../../application/wager/wager-result';
import { FAILURE_CODE_INFO, isFailureCode } from '../../domain/wager/failure-code';
import { errorBody, HttpProblem } from './http-error';

export interface HttpOutcome {
  status: number;
  body: unknown;
}

function transactionBody(r: TransactionResult) {
  return {
    transactionId: r.transactionId,
    status: r.status,
    failureCode: r.failureCode,
    balance: r.balance,
    idempotentReplay: r.idempotentReplay,
  };
}

/**
 * Maps the use-case result to HTTP:
 * 201 new PROCESSED · 200 PROCESSED replay · 202 PENDING_REFERENCE (accepted,
 * pending) · 422 REJECTED (body keeps the result + error.code = failureCode) ·
 * 500 FAILED replay · 409 idempotency conflict · 422 WALLET_NOT_FOUND.
 */
export function presentWagerResult(result: ProcessWagerResult, correlationId: string): HttpOutcome {
  switch (result.outcome) {
    case 'TRANSACTION': {
      const body = transactionBody(result);
      switch (result.status) {
        case 'PROCESSED':
          return { status: result.idempotentReplay ? 200 : 201, body };
        case 'PENDING_REFERENCE':
          return { status: 202, body };
        case 'REJECTED':
        case 'FAILED': {
          const code = result.failureCode ?? 'UNKNOWN';
          const message = isFailureCode(code) ? FAILURE_CODE_INFO[code].description : 'Transaction not applied';
          const err = errorBody(correlationId, code, message, false);
          return { status: result.status === 'REJECTED' ? 422 : 500, body: { ...body, ...err } };
        }
      }
      break;
    }
    case 'IDEMPOTENCY_CONFLICT':
      throw new HttpProblem(
        409,
        'IDEMPOTENCY_CONFLICT',
        result.reason === 'PAYLOAD_MISMATCH'
          ? 'Idempotency-Key already used with a different payload'
          : 'Idempotency identity already bound to another transaction',
        { reason: result.reason, existingTransactionId: result.existingTransactionId },
      );
    case 'WALLET_NOT_FOUND':
      throw new HttpProblem(422, 'WALLET_NOT_FOUND', 'Wallet does not exist');
    case 'DUPLICATE_MESSAGE':
      break;
  }
  throw new Error(`unexpected result ${JSON.stringify(result)}`);
}

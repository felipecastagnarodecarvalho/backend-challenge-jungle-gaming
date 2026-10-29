import type { MoneyProps } from '../../domain/money/money';
import type { FailureCode } from '../../domain/wager/failure-code';
import type { WagerTransaction } from '../../domain/wager/wager-transaction';

export type TransactionOutcomeStatus = 'PROCESSED' | 'REJECTED' | 'PENDING_REFERENCE' | 'FAILED';

export type IdempotencyConflictReason =
  | 'PAYLOAD_MISMATCH'
  | 'EXTERNAL_ID_BOUND_TO_OTHER_KEY'
  | 'KEY_AND_EXTERNAL_ID_MISMATCH';

/**
 * Result of ProcessWagerTransaction. Business outcomes are values, never
 * exceptions, so HTTP and SQS map them explicitly (status code / ack).
 */
export type ProcessWagerResult =
  | {
      outcome: 'TRANSACTION';
      transactionId: string;
      status: TransactionOutcomeStatus;
      failureCode: FailureCode | null;
      balance: MoneyProps | null;
      walletVersion: number | null;
      idempotentReplay: boolean;
    }
  | { outcome: 'IDEMPOTENCY_CONFLICT'; reason: IdempotencyConflictReason; existingTransactionId: string }
  | { outcome: 'WALLET_NOT_FOUND' }
  | { outcome: 'DUPLICATE_MESSAGE' };

export type TransactionResult = Extract<ProcessWagerResult, { outcome: 'TRANSACTION' }>;

/**
 * Builds the response from the transaction's *current* persisted state, with
 * the balance observed when that state was reached. A replay therefore returns
 * the original result — or the final one if a pending reference got resolved.
 */
export function toResultFromTransaction(tx: WagerTransaction, idempotentReplay: boolean): TransactionResult {
  if (tx.status === 'PENDING') {
    throw new Error(`transaction ${tx.id} has no outcome yet`);
  }
  return {
    outcome: 'TRANSACTION',
    transactionId: tx.id,
    status: tx.status,
    failureCode: tx.failureCode ?? null,
    balance: tx.resultBalance ? tx.resultBalance.toJSON() : null,
    walletVersion: tx.resultWalletVersion ?? null,
    idempotentReplay,
  };
}

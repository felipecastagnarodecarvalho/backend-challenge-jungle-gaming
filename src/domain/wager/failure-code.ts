/**
 * Stable, machine-readable reasons for REJECTED/FAILED transactions.
 *
 * `retryable` answers "can re-sending the *same* request produce a different
 * result?". For every persisted rejection the answer is no: the idempotency key
 * stays bound to the outcome; the provider must fix the payload and send a
 * *new* transaction (new external id / key).
 */
export const FailureCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  ReversalInsufficientFunds: 'REVERSAL_INSUFFICIENT_FUNDS',
  CurrencyMismatch: 'CURRENCY_MISMATCH',
  WalletPlayerMismatch: 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound: 'REFERENCE_NOT_FOUND',
  ReferenceMismatch: 'REFERENCE_MISMATCH',
  InvalidReferenceKind: 'INVALID_REFERENCE_KIND',
  ReferenceNotProcessed: 'REFERENCE_NOT_PROCESSED',
  AlreadyReversed: 'ALREADY_REVERSED',
  AmountMismatch: 'AMOUNT_MISMATCH',
  ProcessingError: 'PROCESSING_ERROR',
  WalletNotFound: 'WALLET_NOT_FOUND',
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export interface FailureCodeInfo {
  retryable: boolean;
  description: string;
}

export const FAILURE_CODE_INFO: Readonly<Record<FailureCode, FailureCodeInfo>> = {
  INSUFFICIENT_FUNDS: { retryable: false, description: 'Bet amount exceeds the wallet balance' },
  REVERSAL_INSUFFICIENT_FUNDS: {
    retryable: false,
    description: 'Reversal would make the balance negative; requires operational intervention',
  },
  CURRENCY_MISMATCH: { retryable: false, description: 'Operation currency differs from the wallet currency' },
  WALLET_PLAYER_MISMATCH: { retryable: false, description: 'Wallet does not belong to the given player' },
  REFERENCE_NOT_FOUND: {
    retryable: false,
    description: 'Referenced transaction did not arrive within the retry window',
  },
  REFERENCE_MISMATCH: {
    retryable: false,
    description: 'Referenced transaction belongs to another wallet/player/currency/round',
  },
  INVALID_REFERENCE_KIND: { retryable: false, description: 'Referenced transaction kind is not allowed' },
  REFERENCE_NOT_PROCESSED: { retryable: false, description: 'Referenced transaction was rejected or failed' },
  ALREADY_REVERSED: { retryable: false, description: 'Referenced transaction was already reversed' },
  AMOUNT_MISMATCH: { retryable: false, description: 'Reversal amount differs from the referenced amount' },
  PROCESSING_ERROR: { retryable: false, description: 'Unexpected permanent error while processing' },
  WALLET_NOT_FOUND: { retryable: false, description: 'Wallet does not exist' },
};

export function isFailureCode(value: string): value is FailureCode {
  return Object.hasOwn(FAILURE_CODE_INFO, value);
}

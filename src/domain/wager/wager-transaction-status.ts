export const WagerTransactionStatus = {
  /** Accepted, not yet applied (in-memory only today; the schema allows it for async acceptance). */
  Pending: 'PENDING',
  /** Waiting for the referenced transaction to arrive (out-of-order delivery). */
  PendingReference: 'PENDING_REFERENCE',
  /** Applied (terminal). */
  Processed: 'PROCESSED',
  /** Business-rule violation (terminal). */
  Rejected: 'REJECTED',
  /** Permanent infrastructure/processing error (terminal, auditable). */
  Failed: 'FAILED',
} as const;
export type WagerTransactionStatus = (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

export const TERMINAL_STATUSES: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

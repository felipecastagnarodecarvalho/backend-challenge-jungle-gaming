import type { WagerTransaction } from '../../domain/wager/wager-transaction';
import type { WagerTransactionStatus } from '../../domain/wager/wager-transaction-status';

export interface PendingReferenceClaim {
  id: string;
  walletId: string;
}

/** Bound to the current SQL transaction. */
export interface WagerTransactionRepository {
  /** Rows matching the idempotency key OR the (provider, externalId) pair (0, 1 or 2 rows). */
  findForIdempotency(idempotencyKey: string, providerId: string, externalId: string): Promise<WagerTransaction[]>;
  findByProviderExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null>;
  findByIdForUpdate(id: string): Promise<WagerTransaction | null>;
  /** True when a PROCESSED REFUND/ROLLBACK already points at the reference. */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** `INSERT … ON CONFLICT DO NOTHING`; false when another transaction owns the identity. */
  insertIfAbsent(tx: WagerTransaction): Promise<boolean>;
  /** Guarded update (`WHERE id = ? AND status = ?`). */
  update(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void>;
  /** Claims due PENDING_REFERENCE rows with SKIP LOCKED and pushes their due time by a lease. */
  claimDuePendingReferences(limit: number, leaseMs: number): Promise<PendingReferenceClaim[]>;
  /** Makes transactions waiting on (provider, externalId) due now (optimisation, not a guarantee). */
  nudgeAwaiting(providerId: string, externalId: string, walletId: string): Promise<number>;
}

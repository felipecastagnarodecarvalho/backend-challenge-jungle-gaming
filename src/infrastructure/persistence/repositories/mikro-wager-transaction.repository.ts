import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';
import { ConcurrencyInvariantError } from '../../../application/errors';
import type {
  PendingReferenceClaim,
  WagerTransactionRepository,
} from '../../../application/ports/wager-transaction-repository';
import type { WagerTransaction } from '../../../domain/wager/wager-transaction';
import type { WagerTransactionStatus } from '../../../domain/wager/wager-transaction-status';
import { WagerTransactionMapper } from '../mappers';
import { type WagerTransactionRecord, WagerTransactionSchema } from '../schemas/wager-transaction.schema';
import { asRows } from './sql-rows';

const INSERT_COLUMNS: Array<[keyof WagerTransactionRecord, string]> = [
  ['id', 'id'],
  ['providerId', 'provider_id'],
  ['externalTransactionId', 'external_transaction_id'],
  ['idempotencyKey', 'idempotency_key'],
  ['payloadHash', 'payload_hash'],
  ['walletId', 'wallet_id'],
  ['playerId', 'player_id'],
  ['roundId', 'round_id'],
  ['gameId', 'game_id'],
  ['kind', 'kind'],
  ['amount', 'amount'],
  ['currency', 'currency'],
  ['referenceExternalTransactionId', 'reference_external_transaction_id'],
  ['referenceTransactionId', 'reference_transaction_id'],
  ['status', 'status'],
  ['failureCode', 'failure_code'],
  ['resultBalanceAmount', 'result_balance_amount'],
  ['resultWalletVersion', 'result_wallet_version'],
  ['referenceAttempts', 'reference_attempts'],
  ['nextReferenceCheckAt', 'next_reference_check_at'],
  ['source', 'source'],
  ['correlationId', 'correlation_id'],
  ['createdAt', 'created_at'],
  ['updatedAt', 'updated_at'],
  ['processedAt', 'processed_at'],
];

const INSERT_SQL = `INSERT INTO wager_transactions (${INSERT_COLUMNS.map(([, c]) => c).join(', ')})
VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})
ON CONFLICT DO NOTHING
RETURNING id`;

export class MikroWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async findForIdempotency(
    idempotencyKey: string,
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction[]> {
    const records = await this.em.find(
      WagerTransactionSchema,
      { $or: [{ idempotencyKey }, { providerId, externalTransactionId: externalId }] },
      { disableIdentityMap: true },
    );
    return records.map(WagerTransactionMapper.toDomain);
  }

  async findByProviderExternalId(providerId: string, externalId: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { providerId, externalTransactionId: externalId },
      { disableIdentityMap: true },
    );
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async findByIdForUpdate(id: string): Promise<WagerTransaction | null> {
    const record = await this.em.findOne(
      WagerTransactionSchema,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, disableIdentityMap: true },
    );
    return record ? WagerTransactionMapper.toDomain(record) : null;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionSchema, {
      referenceTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  /**
   * `ON CONFLICT DO NOTHING` (any unique constraint): returns false instead of
   * aborting the transaction when another transaction already owns the
   * idempotency key or (provider, externalId). The caller turns that into a
   * retry, which then resolves as replay/conflict.
   */
  async insertIfAbsent(tx: WagerTransaction): Promise<boolean> {
    const record = WagerTransactionMapper.toRecord(tx);
    const params = INSERT_COLUMNS.map(([key]) => record[key]);
    const rows = asRows(await this.em.execute(INSERT_SQL, params, 'all'));
    return rows.length === 1;
  }

  async update(tx: WagerTransaction, expectedStatus: WagerTransactionStatus): Promise<void> {
    const r = WagerTransactionMapper.toRecord(tx);
    const affected = await this.em.nativeUpdate(
      WagerTransactionSchema,
      { id: tx.id, status: expectedStatus },
      {
        status: r.status,
        referenceTransactionId: r.referenceTransactionId,
        failureCode: r.failureCode,
        resultBalanceAmount: r.resultBalanceAmount,
        resultWalletVersion: r.resultWalletVersion,
        referenceAttempts: r.referenceAttempts,
        nextReferenceCheckAt: r.nextReferenceCheckAt,
        updatedAt: r.updatedAt,
        processedAt: r.processedAt,
      },
    );
    if (affected !== 1) {
      throw new ConcurrencyInvariantError(`wager transaction ${tx.id} not in status ${expectedStatus}`);
    }
  }

  /** SKIP LOCKED gives concurrent workers disjoint batches; the lease hides claimed rows until it expires. */
  async claimDuePendingReferences(limit: number, leaseMs: number): Promise<PendingReferenceClaim[]> {
    const rows = asRows(
      await this.em.execute(
        `WITH due AS (
           SELECT id FROM wager_transactions
            WHERE status = 'PENDING_REFERENCE' AND next_reference_check_at <= now()
            ORDER BY next_reference_check_at
            LIMIT ? FOR UPDATE SKIP LOCKED)
         UPDATE wager_transactions t
            SET next_reference_check_at = now() + (? * interval '1 millisecond'), updated_at = now()
           FROM due WHERE t.id = due.id
         RETURNING t.id, t.wallet_id`,
        [limit, leaseMs],
        'all',
      ),
    );
    return rows.map((r) => ({ id: String(r.id), walletId: String(r.wallet_id) }));
  }

  async nudgeAwaiting(providerId: string, externalId: string, walletId: string): Promise<number> {
    const result = await this.em.execute(
      `UPDATE wager_transactions SET next_reference_check_at = now()
        WHERE status = 'PENDING_REFERENCE' AND provider_id = ? AND reference_external_transaction_id = ?
          AND wallet_id = ? AND next_reference_check_at > now()`,
      [providerId, externalId, walletId],
      'run',
    );
    return (result as { affectedRows?: number }).affectedRows ?? 0;
  }
}

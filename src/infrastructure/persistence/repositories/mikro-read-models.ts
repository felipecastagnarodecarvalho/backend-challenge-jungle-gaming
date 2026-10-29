import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type {
  LedgerEntryView,
  LedgerReadModel,
  OperationalGaugesReadModel,
  ReconciliationReadModel,
  ReconciliationSnapshot,
  WagerTransactionReadModel,
  WagerTransactionView,
  WalletReadModel,
  WalletView,
} from '../../../application/ports/read-models';
import { asRows } from './sql-rows';

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOrNull = (v: unknown): string | null => (v == null ? null : iso(v));
const str = (v: unknown): string => String(v);
const cur = (v: unknown): string => String(v).trim();

function toTxView(r: Row): WagerTransactionView {
  const currency = cur(r.currency);
  return {
    transactionId: str(r.id),
    providerId: str(r.provider_id),
    externalTransactionId: str(r.external_transaction_id),
    idempotencyKey: str(r.idempotency_key),
    walletId: str(r.wallet_id),
    playerId: str(r.player_id),
    roundId: str(r.round_id),
    gameId: str(r.game_id),
    kind: str(r.kind),
    money: { amount: str(r.amount), currency },
    referenceExternalTransactionId:
      r.reference_external_transaction_id == null ? null : str(r.reference_external_transaction_id),
    referenceTransactionId: r.reference_transaction_id == null ? null : str(r.reference_transaction_id),
    status: str(r.status),
    failureCode: r.failure_code == null ? null : str(r.failure_code),
    balanceAfter: r.result_balance_amount == null ? null : { amount: str(r.result_balance_amount), currency },
    walletVersion: r.result_wallet_version == null ? null : Number(r.result_wallet_version),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    processedAt: isoOrNull(r.processed_at),
  };
}

/**
 * Query-side adapters: plain SQL on a fresh forked EntityManager, outside any
 * write transaction. Monetary columns are cast to text in SQL so they never
 * pass through a JS number.
 */
export class MikroReadModels
  implements WalletReadModel, LedgerReadModel, ReconciliationReadModel, OperationalGaugesReadModel
{
  constructor(private readonly orm: MikroORM) {}

  private em(): EntityManager {
    return this.orm.em.fork({ clear: true });
  }

  private async query(sql: string, params: unknown[] = [], em: EntityManager = this.em()): Promise<Row[]> {
    return asRows(await em.execute(sql, params, 'all'));
  }

  async getById(id: string): Promise<WalletView | null> {
    const [r] = await this.query(
      'SELECT id, player_id, currency, balance::text AS balance, version, created_at, updated_at FROM wallets WHERE id = ?',
      [id],
    );
    if (!r) return null;
    return {
      id: str(r.id),
      playerId: str(r.player_id),
      balance: { amount: str(r.balance), currency: cur(r.currency) },
      version: Number(r.version),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    };
  }

  async page(walletId: string, afterVersion: number, limit: number): Promise<LedgerEntryView[]> {
    const rows = await this.query(
      `SELECT id, transaction_id, direction, amount::text AS amount, currency, balance_before::text AS balance_before,
              balance_after::text AS balance_after, wallet_version, created_at
         FROM wallet_ledger_entries WHERE wallet_id = ? AND wallet_version > ?
        ORDER BY wallet_version ASC LIMIT ?`,
      [walletId, afterVersion, limit],
    );
    return rows.map((r) => {
      const currency = cur(r.currency);
      return {
        id: str(r.id),
        transactionId: str(r.transaction_id),
        direction: str(r.direction),
        money: { amount: str(r.amount), currency },
        balanceBefore: { amount: str(r.balance_before), currency },
        balanceAfter: { amount: str(r.balance_after), currency },
        walletVersion: Number(r.wallet_version),
        createdAt: iso(r.created_at),
      };
    });
  }

  private static readonly TX_COLUMNS =
    `id, provider_id, external_transaction_id, idempotency_key, wallet_id, player_id, round_id,
    game_id, kind, amount::text AS amount, currency, reference_external_transaction_id, reference_transaction_id, status,
    failure_code, result_balance_amount::text AS result_balance_amount, result_wallet_version, created_at, updated_at, processed_at`;

  async getTransactionById(id: string): Promise<WagerTransactionView | null> {
    const [r] = await this.query(`SELECT ${MikroReadModels.TX_COLUMNS} FROM wager_transactions WHERE id = ?`, [id]);
    return r ? toTxView(r) : null;
  }

  async getByProviderExternalId(providerId: string, externalId: string): Promise<WagerTransactionView | null> {
    const [r] = await this.query(
      `SELECT ${MikroReadModels.TX_COLUMNS} FROM wager_transactions WHERE provider_id = ? AND external_transaction_id = ?`,
      [providerId, externalId],
    );
    return r ? toTxView(r) : null;
  }

  /** One REPEATABLE READ, READ ONLY snapshot: consistent across the 4 queries, never blocks writers. */
  async snapshot(walletId: string): Promise<ReconciliationSnapshot | null> {
    return this.em().transactional(
      async (em) => {
        const [w] = await this.query(
          'SELECT id, currency, balance::text AS balance, version FROM wallets WHERE id = ?',
          [walletId],
          em,
        );
        if (!w) return null;
        const [agg] = await this.query(
          `SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(22,2)::text AS ledger_sum,
                  COUNT(*)::int AS entries
             FROM wallet_ledger_entries WHERE wallet_id = ?`,
          [walletId],
          em,
        );
        const [last] = await this.query(
          `SELECT wallet_version, balance_after::text AS balance_after FROM wallet_ledger_entries
            WHERE wallet_id = ? ORDER BY wallet_version DESC LIMIT 1`,
          [walletId],
          em,
        );
        const [breaks] = await this.query(
          `SELECT COUNT(*)::int AS chain_breaks FROM (
             SELECT balance_before, LAG(balance_after, 1, 0::numeric) OVER (ORDER BY wallet_version) AS prev_after
               FROM wallet_ledger_entries WHERE wallet_id = ?) t
            WHERE balance_before <> prev_after`,
          [walletId],
          em,
        );
        return {
          wallet: { id: str(w.id), currency: cur(w.currency), balance: str(w.balance), version: Number(w.version) },
          ledgerSum: str(agg?.ledger_sum ?? '0.00'),
          entries: Number(agg?.entries ?? 0),
          lastEntry: last
            ? { walletVersion: Number(last.wallet_version), balanceAfter: str(last.balance_after) }
            : null,
          chainBreaks: Number(breaks?.chain_breaks ?? 0),
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }

  async outboxPending(): Promise<{ count: number; oldestAgeSeconds: number }> {
    const [r] = await this.query(
      `SELECT COUNT(*)::int AS count,
              COALESCE(EXTRACT(EPOCH FROM now() - MIN(occurred_at)), 0)::float8 AS age
         FROM outbox_messages WHERE published_at IS NULL`,
    );
    return { count: Number(r?.count ?? 0), oldestAgeSeconds: Math.max(0, Number(r?.age ?? 0)) };
  }

  async pendingReferences(): Promise<number> {
    const [r] = await this.query(
      `SELECT COUNT(*)::int AS count FROM wager_transactions WHERE status = 'PENDING_REFERENCE'`,
    );
    return Number(r?.count ?? 0);
  }
}

/** Adapter exposing the transaction read model under its port method names. */
export class MikroWagerTransactionReadModel implements WagerTransactionReadModel {
  constructor(private readonly models: MikroReadModels) {}
  getById(id: string): Promise<WagerTransactionView | null> {
    return this.models.getTransactionById(id);
  }
  getByProviderExternalId(providerId: string, externalId: string): Promise<WagerTransactionView | null> {
    return this.models.getByProviderExternalId(providerId, externalId);
  }
}

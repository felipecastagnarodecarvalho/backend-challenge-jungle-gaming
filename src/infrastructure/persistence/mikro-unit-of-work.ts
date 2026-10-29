import { IsolationLevel } from '@mikro-orm/core';
import type { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { TransactionScope, UnitOfWork, UnitOfWorkOptions } from '../../application/ports/unit-of-work';
import { classifyDatabaseError } from './pg-error-classifier';
import { MikroInboxRepository } from './repositories/mikro-inbox.repository';
import { MikroLedgerRepository } from './repositories/mikro-ledger.repository';
import { MikroOutboxRepository } from './repositories/mikro-outbox.repository';
import { MikroWagerTransactionRepository } from './repositories/mikro-wager-transaction.repository';
import { MikroWalletRepository } from './repositories/mikro-wallet.repository';

export interface UnitOfWorkTimeouts {
  lockTimeoutMs: number;
  statementTimeoutMs: number;
}

export function buildScope(em: EntityManager): TransactionScope {
  return {
    wallets: new MikroWalletRepository(em),
    transactions: new MikroWagerTransactionRepository(em),
    ledger: new MikroLedgerRepository(em),
    inbox: new MikroInboxRepository(em),
    outbox: new MikroOutboxRepository(em),
  };
}

/**
 * Explicit unit of work: one forked EntityManager and one SQL transaction per
 * `run`. `lock_timeout`/`statement_timeout` are set with `set_config(..., true)`
 * (transaction-scoped) so a hot wallet can never block a connection forever.
 * MikroORM's implicit flush is not used — repositories write natively — so the
 * domain objects stay decoupled from the identity map.
 */
export class MikroUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly timeouts: UnitOfWorkTimeouts,
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T> {
    const em = this.orm.em.fork({ clear: true });
    try {
      return await em.transactional(
        async (tx) => {
          await tx.execute(
            `select set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true)`,
            [`${this.timeouts.lockTimeoutMs}ms`, `${this.timeouts.statementTimeoutMs}ms`],
            'all',
          );
          return work(buildScope(tx));
        },
        {
          isolationLevel:
            options?.isolation === 'REPEATABLE_READ' ? IsolationLevel.REPEATABLE_READ : IsolationLevel.READ_COMMITTED,
        },
      );
    } catch (err) {
      // Also catches the DEFERRED constraint trigger, which fires at COMMIT.
      throw classifyDatabaseError(err);
    }
  }
}

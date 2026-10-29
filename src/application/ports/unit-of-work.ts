import type { InboxRepository } from './inbox-repository';
import type { LedgerRepository } from './ledger-repository';
import type { OutboxRepository } from './outbox-repository';
import type { WagerTransactionRepository } from './wager-transaction-repository';
import type { WalletRepository } from './wallet-repository';

/** Repositories bound to one SQL transaction. */
export interface TransactionScope {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: LedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

export interface UnitOfWorkOptions {
  isolation?: 'READ_COMMITTED' | 'REPEATABLE_READ';
}

export interface UnitOfWork {
  /**
   * Runs `work` in ONE SQL transaction: commit if it resolves, rollback if it
   * throws. Database errors (including the deferred constraint trigger fired
   * at COMMIT) are translated into application errors.
   */
  run<T>(work: (scope: TransactionScope) => Promise<T>, options?: UnitOfWorkOptions): Promise<T>;
}

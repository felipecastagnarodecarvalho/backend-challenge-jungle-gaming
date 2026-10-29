import { InvalidMoneyError, Money, type MoneyProps } from '../../domain/money/money';
import { WagerTransaction } from '../../domain/wager/wager-transaction';
import { Wallet } from '../../domain/wallet/wallet';
import { UniqueViolationError, ValidationError, WalletAlreadyExistsError } from '../errors';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../messaging/events';
import { OutboxMessage } from '../messaging/outbox-message';
import type { MetricsPort } from '../ports/metrics';
import type { Clock, IdGenerator, LoggerPort } from '../ports/system';
import type { UnitOfWork } from '../ports/unit-of-work';
import { canonicalJson } from '../shared/canonical-json';
import { type RetryPolicy, withTransientRetry } from '../shared/transient-retry';
import { sha256Hex } from '../wager/payload-hash';

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreatedWallet {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
}

export interface CreateWalletDeps {
  uow: UnitOfWork;
  clock: Clock;
  ids: IdGenerator;
  metrics: MetricsPort;
  logger: LoggerPort;
  retry: RetryPolicy;
}

/**
 * Opens a wallet. A positive initial balance creates the internal OPENING
 * transaction + CREDIT ledger entry + outbox events in the same SQL
 * transaction, so the wallet is ledger-backed from its first commit (the
 * deferred constraint trigger would reject it otherwise).
 * One wallet per (player, currency) is enforced by a UNIQUE constraint → 409.
 */
export class CreateWalletUseCase {
  constructor(private readonly deps: CreateWalletDeps) {}

  async execute(rawInput: CreateWalletInput): Promise<CreatedWallet> {
    const input = { ...rawInput, playerId: rawInput.playerId.toLowerCase() };
    let initialBalance: Money;
    try {
      initialBalance = Money.from(input.initialBalance);
    } catch (err) {
      if (err instanceof InvalidMoneyError)
        throw new ValidationError([{ path: 'initialBalance', message: err.message }]);
      throw err;
    }
    const { uow, clock, ids, metrics, retry, logger } = this.deps;
    try {
      const wallet = await withTransientRetry(
        () =>
          uow.run(async (scope) => {
            const now = clock.now();
            const walletId = ids.next();
            const opening = initialBalance.isPositive()
              ? { transactionId: ids.next(), entryId: ids.next() }
              : undefined;
            const { wallet, openingEntry } = Wallet.open({
              id: walletId,
              playerId: input.playerId,
              initialBalance,
              at: now,
              opening,
            });
            await scope.wallets.insert(wallet);
            if (openingEntry && opening) {
              const tx = WagerTransaction.createOpening({
                id: opening.transactionId,
                walletId,
                playerId: input.playerId,
                money: initialBalance,
                payloadHash: sha256Hex(
                  canonicalJson({
                    walletId,
                    playerId: input.playerId,
                    money: { amount: initialBalance.toJSON().amount, currency: initialBalance.currency },
                  }),
                ),
                at: now,
              });
              await scope.transactions.insertIfAbsent(tx);
              await scope.ledger.append(openingEntry);
              const ctx = { correlationId: input.correlationId, occurredAt: now, nextId: () => ids.next() };
              await scope.outbox.enqueue([
                OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx)),
                OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, openingEntry, ctx)),
              ]);
            }
            return wallet;
          }),
        retry,
        metrics,
        'create_wallet',
      );
      logger.info({ walletId: wallet.id, correlationId: input.correlationId }, 'wallet created');
      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
        createdAt: wallet.createdAt.toISOString(),
      };
    } catch (err) {
      if (err instanceof UniqueViolationError && err.constraint === 'wallets_player_currency_uk') {
        throw new WalletAlreadyExistsError();
      }
      throw err;
    }
  }
}

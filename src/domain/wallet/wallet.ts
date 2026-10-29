import { LedgerDirection } from '../ledger/ledger-direction';
import { WalletLedgerEntry } from '../ledger/wallet-ledger-entry';
import { CurrencyMismatchError, Money } from '../money/money';
import { InsufficientFundsError, InvalidWalletError } from './wallet.errors';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

/**
 * Aggregate root for a player's balance in one currency.
 *
 * Invariants:
 * - balance is never negative;
 * - the only way to change `_balance` is {@link debit}/{@link credit}, each of
 *   which returns the matching {@link WalletLedgerEntry} — "every balance
 *   change has a ledger line" holds structurally;
 * - `version` starts at 1 and increments by exactly 1 per balance change, so it
 *   always equals the `walletVersion` of the newest ledger entry.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Opens a wallet at version 1. A positive initial balance yields the OPENING
   * credit entry (version 1), so balance and ledger agree from birth.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
    opening?: { transactionId: string; entryId: string };
  }): { wallet: Wallet; openingEntry: WalletLedgerEntry | undefined } {
    const { initialBalance, at } = props;
    if (initialBalance.isNegative()) {
      throw new InvalidWalletError('initial balance must not be negative');
    }
    const wallet = new Wallet(props.id, props.playerId, initialBalance.currency, initialBalance, 1, at, at);
    if (initialBalance.isZero()) {
      return { wallet, openingEntry: undefined };
    }
    if (!props.opening) {
      throw new InvalidWalletError('opening transaction ids are required when initial balance is positive');
    }
    const openingEntry = WalletLedgerEntry.create({
      id: props.opening.entryId,
      walletId: props.id,
      transactionId: props.opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Rebuilds persisted state; does not re-validate. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  /** Debits `money`. Throws InsufficientFundsError (defensive: the policy decides first). */
  debit(p: WalletMovement): WalletLedgerEntry {
    this.assertMovement(p.money);
    if (!this.canDebit(p.money)) {
      throw new InsufficientFundsError(this.id);
    }
    return this.apply(LedgerDirection.Debit, p);
  }

  credit(p: WalletMovement): WalletLedgerEntry {
    this.assertMovement(p.money);
    return this.apply(LedgerDirection.Credit, p);
  }

  private apply(direction: LedgerDirection, p: WalletMovement): WalletLedgerEntry {
    const before = this._balance;
    const after = direction === LedgerDirection.Debit ? before.subtract(p.money) : before.add(p.money);
    const nextVersion = this._version + 1;
    // The entry is built (and validated) before mutating state: a failure leaves the wallet untouched.
    const entry = WalletLedgerEntry.create({
      id: p.entryId,
      walletId: this.id,
      transactionId: p.transactionId,
      direction,
      money: p.money,
      balanceBefore: before,
      balanceAfter: after,
      walletVersion: nextVersion,
      createdAt: p.at,
    });
    this._balance = after;
    this._version = nextVersion;
    this._updatedAt = p.at;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletError('movement amount must be positive');
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

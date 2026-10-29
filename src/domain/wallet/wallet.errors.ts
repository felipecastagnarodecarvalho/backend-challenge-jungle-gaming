import { DomainError } from '../shared/domain-error';

export { CurrencyMismatchError } from '../money/money';

export class InsufficientFundsError extends DomainError {
  readonly code = 'INSUFFICIENT_FUNDS';
  constructor(walletId: string) {
    super(`Insufficient funds in wallet ${walletId}`);
  }
}

export class InvalidWalletError extends DomainError {
  readonly code = 'INVALID_WALLET';
  constructor(message: string) {
    super(message);
  }
}

import { DomainError } from '../shared/domain-error';

/** Invalid command shape for a wager transaction (maps to HTTP 400). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = 'INVALID_WAGER_TRANSACTION';
  constructor(message: string) {
    super(message);
  }
}

/**
 * An illegal state transition was attempted. This is a programming error
 * (the use cases never transition terminal transactions), not a business path.
 */
export class InvalidTransactionStateError extends DomainError {
  readonly code = 'INVALID_TRANSACTION_STATE';
  constructor(message: string) {
    super(message);
  }
}

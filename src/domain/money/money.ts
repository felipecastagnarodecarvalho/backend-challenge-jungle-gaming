import Decimal from 'decimal.js';
import { DomainError } from '../shared/domain-error';

/** Wire format of a monetary amount: decimal string with exactly 2 places + ISO-4217 code. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends DomainError {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = 'CURRENCY_MISMATCH';
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Isolated Decimal constructor: never mutate the global Decimal config.
 * 40 significant digits comfortably hold NUMERIC(20,2); exponent bounds keep
 * `toFixed` out of scientific notation.
 */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN, toExpNeg: -40, toExpPos: 40 });

/** Up to 15 integer digits, exactly 2 decimals, no sign, no exponent, no leading zeros. */
const AMOUNT_PATTERN = /^(0|[1-9][0-9]{0,14})\.[0-9]{2}$/;
/** Signed variant used only to rebuild values produced by the system (e.g. SQL sums). */
const SIGNED_AMOUNT_PATTERN = /^-?(0|[1-9][0-9]{0,17})\.[0-9]{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;

/**
 * Immutable monetary value object with fixed scale 2.
 *
 * Invariants: amounts are exact decimals (never JS `number`); every operation
 * returns a new instance and never rounds; mixing currencies throws
 * {@link CurrencyMismatchError}. `from` is the strict *input contract*
 * (non-negative canonical string); arithmetic may yield negatives, which are
 * only used internally (e.g. reconciliation differences).
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (value.decimalPlaces() > SCALE) {
      throw new InvalidMoneyError('Money must have at most 2 decimal places');
    }
  }

  /** Parses an input-contract amount. Rejects NaN/Infinity/exponents/negatives/wrong scale. */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== 'object') {
      throw new InvalidMoneyError('Money must be an object { amount, currency }');
    }
    const { amount, currency } = props;
    if (typeof amount !== 'string' || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError('amount must be a non-negative decimal string with exactly 2 decimal places');
    }
    Money.assertCurrency(currency);
    return new Money(new D(amount), currency);
  }

  /**
   * Rebuilds a possibly negative amount produced by the system itself
   * (e.g. a ledger sum read back from SQL). Not an input contract.
   */
  static fromSigned(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !SIGNED_AMOUNT_PATTERN.test(props.amount)) {
      throw new InvalidMoneyError(`invalid signed amount: ${String(props.amount)}`);
    }
    Money.assertCurrency(props.currency);
    return new Money(new D(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new D(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  /** Value equality. Different currencies are simply "not equal" (does not throw). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.amountString(), currency: this.currency };
  }

  toString(): string {
    return `${this.amountString()} ${this.currency}`;
  }

  /** Fixed scale-2 string; normalises negative zero to "0.00". */
  private amountString(): string {
    return this.value.isZero() ? '0.00' : this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError('currency must be a 3-letter uppercase ISO-4217 code');
    }
  }
}

import Decimal from 'decimal.js';
import { DomainError } from '../errors/domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// Isolated configuration: unrelated libraries cannot change monetary precision.
const ExactDecimal = Decimal.clone({ precision: 40 });
const maximumAmount = new ExactDecimal('9999999999999999.99');
const supportedCurrencies = new Set(['BRL', 'USD', 'EUR']);

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (
      typeof props.amount !== 'string' ||
      !/^(0|[1-9]\d{0,15})\.\d{2}$/.test(props.amount)
    ) {
      throw new DomainError(
        'INVALID_MONEY_AMOUNT',
        'Amount must be a non-negative decimal string with two decimal places and at most 16 integer digits',
      );
    }

    Money.assertCurrency(props.currency);
    return new Money(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  /** Rebuilds exact stored values, including signed reconciliation differences. */
  static rehydrate(props: MoneyProps): Money {
    if (
      typeof props.amount !== 'string' ||
      !/^-?(0|[1-9]\d{0,15})\.\d{2}$/.test(props.amount)
    ) {
      throw new DomainError(
        'INVALID_MONEY_AMOUNT',
        'Invalid persisted money amount',
      );
    }

    Money.assertCurrency(props.currency);
    return new Money(new ExactDecimal(props.amount), props.currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withValue(this.value.plus(other.value));
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return this.withValue(this.value.minus(other.value));
  }

  negate(): Money {
    return this.withValue(this.value.negated());
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

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private withValue(value: Decimal): Money {
    if (value.abs().greaterThan(maximumAmount)) {
      throw new DomainError(
        'MONEY_OUT_OF_RANGE',
        'Monetary result exceeds numeric(18,2)',
      );
    }

    return new Money(value, this.currency);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Money currencies must match');
    }
  }

  private static assertCurrency(currency: string): void {
    if (!supportedCurrencies.has(currency)) {
      throw new DomainError(
        'UNSUPPORTED_CURRENCY',
        'Supported currencies: BRL, USD, EUR',
      );
    }
  }
}

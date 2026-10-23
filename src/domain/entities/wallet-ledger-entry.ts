import { DomainError } from '../errors/domain-error';
import { Money } from '../value-objects/money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private readonly timestamp: number;

  private constructor(private readonly state: Readonly<LedgerEntryState>) {
    this.timestamp = state.createdAt.getTime();
    Object.freeze(state);
    Object.freeze(this);
  }

  static create(props: LedgerEntryState): WalletLedgerEntry {
    const entry = new WalletLedgerEntry({ ...props });
    if (!props.money.isPositive()) {
      throw new DomainError(
        'INVALID_LEDGER_AMOUNT',
        'Ledger amount must be positive',
      );
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new DomainError(
        'NEGATIVE_BALANCE',
        'Ledger balances must be non-negative',
      );
    }
    if (!entry.isBalanced()) {
      throw new DomainError(
        'UNBALANCED_LEDGER_ENTRY',
        'Ledger arithmetic is inconsistent',
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry({ ...state });
  }

  get id(): string {
    return this.state.id;
  }

  get walletId(): string {
    return this.state.walletId;
  }

  get transactionId(): string {
    return this.state.transactionId;
  }

  get direction(): LedgerDirection {
    return this.state.direction;
  }

  get money(): Money {
    return this.state.money;
  }

  get balanceBefore(): Money {
    return this.state.balanceBefore;
  }

  get balanceAfter(): Money {
    return this.state.balanceAfter;
  }

  get createdAt(): Date {
    return new Date(this.timestamp);
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Debit
        ? this.balanceBefore.subtract(this.money)
        : this.balanceBefore.add(this.money);
    return expected.equals(this.balanceAfter);
  }
}

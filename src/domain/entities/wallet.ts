import { DomainError } from '../errors/domain-error';
import { Money } from '../value-objects/money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

interface MovementProps {
  ledgerEntryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(private state: WalletState) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new DomainError(
        'NEGATIVE_BALANCE',
        'Initial balance must be non-negative',
      );
    }
    return new Wallet({
      id: props.id,
      playerId: props.playerId,
      currency: props.initialBalance.currency,
      balance: props.initialBalance,
      version: 1,
      createdAt: new Date(props.at),
      updatedAt: new Date(props.at),
    });
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet({
      ...state,
      createdAt: new Date(state.createdAt),
      updatedAt: new Date(state.updatedAt),
    });
  }

  get id(): string {
    return this.state.id;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get currency(): string {
    return this.state.currency;
  }

  get balance(): Money {
    return this.state.balance;
  }

  get version(): number {
    return this.state.version;
  }

  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }

  get updatedAt(): Date {
    return new Date(this.state.updatedAt);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    return this.move(props, LedgerDirection.Debit);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    return this.move(props, LedgerDirection.Credit);
  }

  private move(
    props: MovementProps,
    direction: LedgerDirection,
  ): WalletLedgerEntry {
    if (props.money.currency !== this.currency) {
      throw new DomainError(
        'CURRENCY_MISMATCH',
        'Movement currency must match wallet currency',
      );
    }
    if (!props.money.isPositive()) {
      throw new DomainError(
        'INVALID_MOVEMENT_AMOUNT',
        'Movement amount must be positive',
      );
    }
    const balanceAfter =
      direction === LedgerDirection.Debit
        ? this.balance.subtract(props.money)
        : this.balance.add(props.money);
    if (balanceAfter.isNegative()) {
      throw new DomainError(
        'INSUFFICIENT_FUNDS',
        'Wallet has insufficient funds',
      );
    }
    const entry = WalletLedgerEntry.create({
      id: props.ledgerEntryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this.balance,
      balanceAfter,
      createdAt: props.at,
    });
    this.state = {
      ...this.state,
      balance: balanceAfter,
      version: this.version + 1,
      updatedAt: new Date(props.at),
    };
    return entry;
  }
}

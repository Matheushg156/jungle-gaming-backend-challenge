import { Wallet } from '../entities/wallet';
import {
  WalletLedgerEntry,
  type LedgerDirection,
} from '../entities/wallet-ledger-entry';
import { DomainError } from '../errors/domain-error';
import type { MoneyProps } from '../value-objects/money';
import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from './integration-event';

interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
    super(props);
  }

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    context: EventContext,
  ): WalletBalanceChanged {
    if (
      wallet.id !== entry.walletId ||
      !wallet.balance.equals(entry.balanceAfter)
    ) {
      throw new DomainError(
        'INVALID_EVENT_STATE',
        'Balance event must match the wallet and ledger',
      );
    }
    return new WalletBalanceChanged({
      ...context,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}

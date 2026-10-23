import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../entities/wager-transaction';
import { Wallet } from '../entities/wallet';
import { DomainError } from '../errors/domain-error';
import type { MoneyProps } from '../value-objects/money';
import {
  IntegrationEvent,
  type EventContext,
  type IntegrationEventProps,
} from './integration-event';

interface WagerEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  balance: MoneyProps;
  failureCode?: string;
}

function eventProps(
  transaction: WagerTransaction,
  wallet: Wallet,
  context: EventContext,
  expected: WagerTransactionStatus,
): IntegrationEventProps<WagerEventData> {
  if (transaction.status !== expected || transaction.walletId !== wallet.id) {
    throw new DomainError(
      'INVALID_EVENT_STATE',
      'Event must match the transaction status and wallet',
    );
  }
  return {
    ...context,
    aggregateId: wallet.id,
    data: {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: wallet.id,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      balance: wallet.balance.toJSON(),
      ...(transaction.failureCode
        ? { failureCode: transaction.failureCode }
        : {}),
    },
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
  }
  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    context: EventContext,
  ): WagerTransactionProcessed {
    return new WagerTransactionProcessed(
      eventProps(
        transaction,
        wallet,
        context,
        WagerTransactionStatus.Processed,
      ),
    );
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
  }
  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    context: EventContext,
  ): WagerTransactionRejected {
    return new WagerTransactionRejected(
      eventProps(transaction, wallet, context, WagerTransactionStatus.Rejected),
    );
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;
  private constructor(props: IntegrationEventProps<WagerEventData>) {
    super(props);
  }
  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    context: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(
      eventProps(
        transaction,
        wallet,
        context,
        WagerTransactionStatus.PendingReference,
      ),
    );
  }
}

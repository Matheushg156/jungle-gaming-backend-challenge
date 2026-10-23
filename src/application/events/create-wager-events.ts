import { randomUUID } from 'node:crypto';
import type { Wallet } from '../../domain/entities/wallet';
import type { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
} from '../../domain/events/wager-transaction-events';
import { WalletBalanceChanged } from '../../domain/events/wallet-balance-changed';
import type { ProcessingContext } from './processing-context';

export function createWagerEvents(
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  processing: ProcessingContext,
  previousStatus?: WagerTransactionStatus,
): IntegrationEvent<object>[] {
  const context = () => ({
    eventId: randomUUID(),
    correlationId: processing.correlationId,
    causationId: processing.causationId ?? transaction.id,
    occurredAt: transaction.processedAt ?? new Date(),
  });
  const events: IntegrationEvent<object>[] = [];
  if (transaction.status === WagerTransactionStatus.Processed) {
    events.push(WagerTransactionProcessed.from(transaction, wallet, context()));
  } else if (transaction.status === WagerTransactionStatus.Rejected) {
    events.push(WagerTransactionRejected.from(transaction, wallet, context()));
  } else if (
    transaction.status === WagerTransactionStatus.PendingReference &&
    previousStatus !== transaction.status
  ) {
    events.push(
      WagerTransactionPendingReference.from(transaction, wallet, context()),
    );
  }
  if (entry) {
    events.push(WalletBalanceChanged.from(wallet, entry, context()));
  }
  return events;
}

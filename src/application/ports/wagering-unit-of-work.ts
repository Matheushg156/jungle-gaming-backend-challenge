import type { Wallet } from '../../domain/entities/wallet';
import type { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/entities/wager-transaction';
import type { WagerResult } from '../wagering/wager.contracts';
import type { ReferenceRetryState } from '../wagering/reference-retry-policy';
import type { WagerTransactionKind } from '../../domain/entities/wager-transaction';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import type { ProcessingContext } from '../events/processing-context';

export interface InboxDelivery {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface WagerSubmissionContext extends ProcessingContext {
  inbox?: InboxDelivery;
}

export interface StoredWager {
  transaction: WagerTransaction;
  result: WagerResult | null;
  referenceRetry: ReferenceRetryState | null;
  processingContext: ProcessingContext;
}

export interface PersistWager {
  transaction: WagerTransaction;
  result: WagerResult;
  events: readonly IntegrationEvent<object>[];
  processingContext: ProcessingContext;
  entry?: WalletLedgerEntry;
  referenceRetry?: ReferenceRetryState;
}

export interface LockedWageringContext {
  readonly wallet: Wallet;
  findByIdempotencyKey(key: string): Promise<StoredWager | null>;
  findByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<StoredWager | null>;
  hasProcessedReversal(
    referenceId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean>;
  save(state: PersistWager): Promise<void>;
}

export abstract class WageringUnitOfWork {
  abstract findDueReferences(
    now: Date,
    limit: number,
  ): Promise<{ walletId: string; idempotencyKey: string }[]>;
  abstract findByIdempotencyKey(key: string): Promise<StoredWager | null>;
  abstract withLockedWallet<T>(
    walletId: string,
    action: (context: LockedWageringContext) => Promise<T>,
    inbox?: InboxDelivery,
  ): Promise<T>;
}

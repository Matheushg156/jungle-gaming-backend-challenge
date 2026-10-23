import type { Wallet } from '../../domain/entities/wallet';
import type { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/entities/wager-transaction';
import type { WagerResult } from '../wagering/wager.contracts';
import type { ReferenceRetryState } from '../wagering/reference-retry-policy';
import type { WagerTransactionKind } from '../../domain/entities/wager-transaction';

export interface StoredWager {
  transaction: WagerTransaction;
  result: WagerResult | null;
  referenceRetry: ReferenceRetryState | null;
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
  save(
    transaction: WagerTransaction,
    result: WagerResult,
    entry?: WalletLedgerEntry,
    referenceRetry?: ReferenceRetryState,
  ): Promise<void>;
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
  ): Promise<T>;
}

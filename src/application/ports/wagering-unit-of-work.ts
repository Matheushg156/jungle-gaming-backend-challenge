import type { Wallet } from '../../domain/entities/wallet';
import type { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import type { WagerTransaction } from '../../domain/entities/wager-transaction';
import type { WagerResult } from '../wagering/wager.contracts';

export interface StoredWager {
  transaction: WagerTransaction;
  result: WagerResult | null;
}

export interface LockedWageringContext {
  readonly wallet: Wallet;
  findByIdempotencyKey(key: string): Promise<StoredWager | null>;
  findByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<StoredWager | null>;
  save(
    transaction: WagerTransaction,
    result: WagerResult,
    entry?: WalletLedgerEntry,
  ): Promise<void>;
}

export abstract class WageringUnitOfWork {
  abstract findByIdempotencyKey(key: string): Promise<StoredWager | null>;
  abstract withLockedWallet<T>(
    walletId: string,
    action: (context: LockedWageringContext) => Promise<T>,
  ): Promise<T>;
}

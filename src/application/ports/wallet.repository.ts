import { Wallet } from '../../domain/entities/wallet';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import type { IntegrationEvent } from '../../domain/events/integration-event';
import type { ProcessingContext } from '../events/processing-context';

export interface WalletOpening {
  wallet: Wallet;
  transaction?: WagerTransaction;
  ledgerEntry?: WalletLedgerEntry;
  events: readonly IntegrationEvent<object>[];
  processingContext: ProcessingContext;
}

export abstract class WalletRepository {
  abstract saveOpening(opening: WalletOpening): Promise<void>;
  abstract findById(walletId: string): Promise<Wallet | null>;
}

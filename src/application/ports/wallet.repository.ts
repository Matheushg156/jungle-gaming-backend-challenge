import { Wallet } from '../../domain/entities/wallet';
import { WalletLedgerEntry } from '../../domain/entities/wallet-ledger-entry';
import { WagerTransaction } from '../../domain/entities/wager-transaction';

export interface WalletOpening {
  wallet: Wallet;
  transaction?: WagerTransaction;
  ledgerEntry?: WalletLedgerEntry;
}

export abstract class WalletRepository {
  abstract saveOpening(opening: WalletOpening): Promise<void>;
  abstract findById(walletId: string): Promise<Wallet | null>;
}

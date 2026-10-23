import type { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry';
import type { WalletLedgerEntryRecord } from '../schemas/wallet-ledger-entry.schema';

export function toLedgerRecord(
  entry: WalletLedgerEntry,
): Omit<WalletLedgerEntryRecord, 'sequenceNumber'> {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt,
  };
}

import { DecimalType, EntitySchema } from '@mikro-orm/core';
import { LedgerDirection } from '../../../domain/entities/wallet-ledger-entry';

export interface WalletLedgerEntryRecord {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date;
}

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    name: 'WalletLedgerEntryRecord',
    tableName: 'wallet_ledger_entries',
    properties: {
      id: { type: 'uuid', primary: true },
      walletId: { type: 'uuid' },
      transactionId: { type: 'uuid' },
      direction: { type: 'string' },
      amount: { type: new DecimalType('string'), precision: 18, scale: 2 },
      currency: { type: 'string', length: 3 },
      balanceBefore: {
        type: new DecimalType('string'),
        precision: 18,
        scale: 2,
      },
      balanceAfter: {
        type: new DecimalType('string'),
        precision: 18,
        scale: 2,
      },
      createdAt: { type: Date, columnType: 'timestamptz' },
    },
  });

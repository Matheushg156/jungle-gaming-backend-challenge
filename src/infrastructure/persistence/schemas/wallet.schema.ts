import { DecimalType, EntitySchema } from '@mikro-orm/core';

export interface WalletRecord {
  id: string;
  playerId: string;
  currency: string;
  balance: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  name: 'WalletRecord',
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', length: 3 },
    balance: { type: new DecimalType('string'), precision: 18, scale: 2 },
    version: { type: 'integer' },
    createdAt: { type: Date, columnType: 'timestamptz' },
    updatedAt: { type: Date, columnType: 'timestamptz' },
  },
});

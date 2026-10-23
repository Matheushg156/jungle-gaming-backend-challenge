import { DecimalType, EntitySchema } from '@mikro-orm/core';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import type { WagerResult } from '../../../application/wagering/wager.contracts';

export interface WagerTransactionRecord {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  status: WagerTransactionStatus;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  createdAt: Date;
  processedAt: Date | null;
  result: WagerResult | null;
  referenceAttempts: number;
  nextReferenceAttemptAt: Date | null;
  referenceExpiresAt: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  name: 'WagerTransactionRecord',
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string' },
    walletId: { type: 'uuid' },
    playerId: { type: 'uuid' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    amount: { type: new DecimalType('string'), precision: 18, scale: 2 },
    currency: { type: 'string', length: 3 },
    status: { type: 'string' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'string', nullable: true },
    createdAt: { type: Date, columnType: 'timestamptz' },
    processedAt: { type: Date, columnType: 'timestamptz', nullable: true },
    result: { type: 'json', nullable: true },
    referenceAttempts: { type: 'integer', default: 0 },
    nextReferenceAttemptAt: {
      type: Date,
      columnType: 'timestamptz',
      nullable: true,
    },
    referenceExpiresAt: {
      type: Date,
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});

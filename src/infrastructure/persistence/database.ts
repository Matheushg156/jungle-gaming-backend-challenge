import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migration202610230001 } from './migrations/Migration202610230001';
import { Migration202610230002 } from './migrations/Migration202610230002';
import { Migration202610230003 } from './migrations/Migration202610230003';
import { Migration202610230004 } from './migrations/Migration202610230004';
import { Migration202610230005 } from './migrations/Migration202610230005';
import { OutboxMessageSchema } from './schemas/outbox-message.schema';
import { WalletSchema } from './schemas/wallet.schema';
import { WagerTransactionSchema } from './schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from './schemas/wallet-ledger-entry.schema';

export async function connectDatabase(
  clientUrl = process.env.DATABASE_URL,
): Promise<MikroORM> {
  if (!clientUrl) {
    throw new Error('DATABASE_URL is required');
  }

  return MikroORM.init({
    clientUrl,
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      OutboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        Migration202610230001,
        Migration202610230002,
        Migration202610230003,
        Migration202610230004,
        Migration202610230005,
      ],
      transactional: true,
      allOrNothing: true,
    },
    pool: { min: 0, max: 10 },
    debug: false,
  });
}

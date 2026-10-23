import { Migrator } from '@mikro-orm/migrations';
import { MikroORM } from '@mikro-orm/postgresql';
import { Migration202610230001 } from './migrations/Migration202610230001';
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
    entities: [WalletSchema, WagerTransactionSchema, WalletLedgerEntrySchema],
    extensions: [Migrator],
    migrations: {
      migrationsList: [Migration202610230001],
      transactional: true,
      allOrNothing: true,
    },
    pool: { min: 0, max: 10 },
    debug: false,
  });
}

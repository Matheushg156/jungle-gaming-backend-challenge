import { IsolationLevel } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { WalletReadRepository } from '../../../application/ports/wallet-read.repository';
import type {
  LedgerSlice,
  ReconciliationResult,
} from '../../../application/queries/query.contracts';
import { DomainError } from '../../../domain/errors/domain-error';
import { WalletSchema } from '../schemas/wallet.schema';
import { WalletLedgerEntrySchema } from '../schemas/wallet-ledger-entry.schema';

interface ReconciliationRow {
  id: string;
  currency: string;
  stored_balance: string;
  calculated_balance: string;
  difference: string;
  consistent: boolean;
  checked_entries: number;
}

export class PostgresWalletReadRepository extends WalletReadRepository {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  override async readLedger(
    walletId: string,
    after: string,
    through: string | null,
    limit: number,
  ): Promise<LedgerSlice> {
    return this.orm.em.fork().transactional(
      async (em) => {
        if (!(await em.findOne(WalletSchema, { id: walletId }))) {
          throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found');
        }
        const latest =
          through === null
            ? await em.findOne(
                WalletLedgerEntrySchema,
                { walletId },
                { orderBy: { sequenceNumber: 'desc' } },
              )
            : null;
        const snapshotSequence = through ?? latest?.sequenceNumber ?? '0';
        const records = await em.find(
          WalletLedgerEntrySchema,
          {
            walletId,
            sequenceNumber: { $gt: after, $lte: snapshotSequence },
          },
          { orderBy: { sequenceNumber: 'asc' }, limit: limit + 1 },
        );
        const page = records.slice(0, limit);

        return {
          items: page.map((record) => ({
            id: record.id,
            walletId: record.walletId,
            transactionId: record.transactionId,
            direction: record.direction,
            money: { amount: record.amount, currency: record.currency },
            balanceBefore: {
              amount: record.balanceBefore,
              currency: record.currency,
            },
            balanceAfter: {
              amount: record.balanceAfter,
              currency: record.currency,
            },
            createdAt: record.createdAt.toISOString(),
          })),
          lastSequence: page.at(-1)?.sequenceNumber ?? null,
          snapshotSequence,
          hasMore: records.length > limit,
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }

  override async reconcile(walletId: string): Promise<ReconciliationResult> {
    // One MVCC snapshot covers both the stored balance and all ledger entries.
    // PostgreSQL numeric stays exact even if a corrupted ledger exceeds the Money range.
    const rows = await this.orm.em.fork().execute<ReconciliationRow[]>(
      `
      select w.id, w.currency, w.balance::text as stored_balance,
        coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0.00)::text as calculated_balance,
        (w.balance - coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0.00))::text as difference,
        w.balance = coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0.00) as consistent,
        count(l.id)::integer as checked_entries
      from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      where w.id = ? group by w.id
    `,
      [walletId],
    );
    const row = rows[0];
    if (!row) {
      throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found');
    }

    return {
      walletId: row.id,
      storedBalance: { amount: row.stored_balance, currency: row.currency },
      calculatedBalance: {
        amount: row.calculated_balance,
        currency: row.currency,
      },
      difference: { amount: row.difference, currency: row.currency },
      consistent: row.consistent,
      checkedEntries: row.checked_entries,
    };
  }
}

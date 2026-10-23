import {
  IsolationLevel,
  LockMode,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { MikroORM, type EntityManager } from '@mikro-orm/postgresql';
import {
  WageringUnitOfWork,
  type LockedWageringContext,
  type StoredWager,
} from '../../../application/ports/wagering-unit-of-work';
import type { WagerResult } from '../../../application/wagering/wager.contracts';
import type { Wallet } from '../../../domain/entities/wallet';
import type { WagerTransaction } from '../../../domain/entities/wager-transaction';
import type { WalletLedgerEntry } from '../../../domain/entities/wallet-ledger-entry';
import { DomainError } from '../../../domain/errors/domain-error';
import { rehydrateWallet } from '../mappers/wallet.mapper';
import {
  rehydrateWager,
  toWagerRecord,
} from '../mappers/wager-transaction.mapper';
import { toLedgerRecord } from '../mappers/ledger-entry.mapper';
import { WalletSchema, type WalletRecord } from '../schemas/wallet.schema';
import {
  WagerTransactionSchema,
  type WagerTransactionRecord,
} from '../schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from '../schemas/wallet-ledger-entry.schema';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/entities/wager-transaction';
import type { ReferenceRetryState } from '../../../application/wagering/reference-retry-policy';

function toStoredWager(
  record: WagerTransactionRecord | null,
): StoredWager | null {
  return record
    ? {
        transaction: rehydrateWager(record),
        result: record.result,
        referenceRetry: record.referenceExpiresAt
          ? {
              attempts: record.referenceAttempts,
              nextAttemptAt: record.nextReferenceAttemptAt,
              expiresAt: record.referenceExpiresAt,
            }
          : null,
      }
    : null;
}

class PostgresLockedWageringContext implements LockedWageringContext {
  readonly wallet: Wallet;

  constructor(
    private readonly em: EntityManager,
    private readonly record: WalletRecord,
  ) {
    this.wallet = rehydrateWallet(record);
  }

  async findByIdempotencyKey(key: string): Promise<StoredWager | null> {
    return toStoredWager(
      await this.em.findOne(WagerTransactionSchema, { idempotencyKey: key }),
    );
  }

  async findByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<StoredWager | null> {
    return toStoredWager(
      await this.em.findOne(WagerTransactionSchema, {
        providerId,
        externalTransactionId: externalId,
      }),
    );
  }

  async save(
    transaction: WagerTransaction,
    result: WagerResult,
    entry?: WalletLedgerEntry,
    referenceRetry?: ReferenceRetryState,
  ): Promise<void> {
    const record = toWagerRecord(transaction, result, referenceRetry);
    const existing = await this.em.findOne(WagerTransactionSchema, {
      id: transaction.id,
    });
    if (existing) {
      this.em.assign(existing, record);
    } else {
      this.em.create(WagerTransactionSchema, record);
    }
    await this.em.flush();

    if (entry) {
      this.record.balance = this.wallet.balance.toString();
      this.record.version = this.wallet.version;
      this.record.updatedAt = this.wallet.updatedAt;
      this.em.create(WalletLedgerEntrySchema, toLedgerRecord(entry));
      await this.em.flush();
    }
  }

  async hasProcessedReversal(
    referenceId: string,
    kind: WagerTransactionKind,
  ): Promise<boolean> {
    return (
      (await this.em.count(WagerTransactionSchema, {
        referenceTransactionId: referenceId,
        kind,
        status: WagerTransactionStatus.Processed,
      })) > 0
    );
  }
}

export class PostgresWageringUnitOfWork extends WageringUnitOfWork {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  override async findDueReferences(
    now: Date,
    limit: number,
  ): Promise<{ walletId: string; idempotencyKey: string }[]> {
    const records = await this.orm.em.fork().find(
      WagerTransactionSchema,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [
          { nextReferenceAttemptAt: { $lte: now } },
          { referenceExpiresAt: { $lte: now } },
        ],
      },
      { limit, orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' } },
    );
    return records.map(({ walletId, idempotencyKey }) => ({
      walletId,
      idempotencyKey,
    }));
  }

  override async findByIdempotencyKey(
    key: string,
  ): Promise<StoredWager | null> {
    return toStoredWager(
      await this.orm.em
        .fork()
        .findOne(WagerTransactionSchema, { idempotencyKey: key }),
    );
  }

  override async withLockedWallet<T>(
    walletId: string,
    action: (context: LockedWageringContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await em.execute("set local lock_timeout = '5s'");
          await em.execute("set local statement_timeout = '15s'");
          const record = await em.findOne(
            WalletSchema,
            { id: walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );
          if (!record) {
            throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found');
          }

          return action(new PostgresLockedWageringContext(em, record));
        },
        { isolationLevel: IsolationLevel.READ_COMMITTED },
      );
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) {
        // Cross-wallet key collisions can race despite separate wallet locks.
        // The database rejects the loser and rolls back all of its effects.
        throw new DomainError(
          'TRANSACTION_IDENTITY_CONFLICT',
          'Idempotency key or provider transaction already exists',
        );
      }
      throw error;
    }
  }
}

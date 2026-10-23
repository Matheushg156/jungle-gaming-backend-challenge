import { InboxMessage } from '../../../domain/entities/inbox-message';
import { InboxMessageSchema } from '../schemas/inbox-message.schema';
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
  type PersistWager,
  type InboxDelivery,
} from '../../../application/ports/wagering-unit-of-work';
import type { Wallet } from '../../../domain/entities/wallet';
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
import { enqueueEvents } from '../enqueue-events';

function toStoredWager(
  record: WagerTransactionRecord | null,
): StoredWager | null {
  return record
    ? {
        transaction: rehydrateWager(record),
        result: record.result,
        processingContext: {
          correlationId: record.correlationId,
          ...(record.causationId ? { causationId: record.causationId } : {}),
        },
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

  async save({
    transaction,
    result,
    entry,
    referenceRetry,
    events,
    processingContext,
  }: PersistWager): Promise<void> {
    const record = toWagerRecord(
      transaction,
      result,
      referenceRetry,
      processingContext,
    );
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
    enqueueEvents(this.em, events);
    await this.em.flush();
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
    delivery?: InboxDelivery,
  ): Promise<T> {
    try {
      return await this.orm.em.fork().transactional(
        async (em) => {
          await em.execute("set local lock_timeout = '5s'");
          await em.execute("set local statement_timeout = '15s'");
          // Always acquire the inbox before the wallet, in every consumer instance.
          const inbox = delivery
            ? await this.lockInbox(em, delivery)
            : undefined;
          const record = await em.findOne(
            WalletSchema,
            { id: walletId },
            { lockMode: LockMode.PESSIMISTIC_WRITE },
          );
          if (!record) {
            throw new DomainError('WALLET_NOT_FOUND', 'Wallet not found');
          }

          const result = await action(
            new PostgresLockedWageringContext(em, record),
          );
          if (inbox && !inbox.isProcessed()) {
            const processedAt = new Date();
            inbox.markProcessed(processedAt);
            await em.nativeUpdate(
              InboxMessageSchema,
              { consumerName: inbox.consumerName, messageId: inbox.messageId },
              { processedAt },
            );
          }
          return result;
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
  private async lockInbox(
    em: EntityManager,
    delivery: InboxDelivery,
  ): Promise<InboxMessage> {
    const candidate = InboxMessage.receive(delivery);
    await em.execute(
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?) on conflict (consumer_name, message_id) do nothing`,
      [
        candidate.consumerName,
        candidate.messageId,
        candidate.payloadHash,
        candidate.receivedAt,
      ],
    );
    const record = await em.findOneOrFail(
      InboxMessageSchema,
      { consumerName: delivery.consumerName, messageId: delivery.messageId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    const inbox = InboxMessage.rehydrate(record);
    inbox.assertPayload(delivery.payloadHash);
    return inbox;
  }
}

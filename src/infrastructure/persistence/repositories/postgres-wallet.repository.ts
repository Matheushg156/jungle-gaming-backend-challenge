import type { ProcessingObserver } from '../../../application/ports/processing-observer';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  WalletRepository,
  type WalletOpening,
} from '../../../application/ports/wallet.repository';
import { Wallet } from '../../../domain/entities/wallet';
import { DomainError } from '../../../domain/errors/domain-error';
import { rehydrateWallet } from '../mappers/wallet.mapper';
import { toWagerRecord } from '../mappers/wager-transaction.mapper';
import { toLedgerRecord } from '../mappers/ledger-entry.mapper';
import { WalletSchema } from '../schemas/wallet.schema';
import { WagerTransactionSchema } from '../schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from '../schemas/wallet-ledger-entry.schema';
import { enqueueEvents } from '../enqueue-events';

export class PostgresWalletRepository extends WalletRepository {
  constructor(
    private readonly orm: MikroORM,
    private readonly observer?: ProcessingObserver,
  ) {
    super();
  }

  override async saveOpening({
    wallet,
    transaction,
    ledgerEntry,
    events,
    processingContext,
  }: WalletOpening): Promise<void> {
    const started = performance.now();
    try {
      // A separate EntityManager gives each operation its own Unit of Work and Identity Map.
      await this.orm.em.fork().transactional(async (em) => {
        em.create(WalletSchema, {
          id: wallet.id,
          playerId: wallet.playerId,
          currency: wallet.currency,
          balance: wallet.balance.toString(),
          version: wallet.version,
          createdAt: wallet.createdAt,
          updatedAt: wallet.updatedAt,
        });
        // Explicit flush order respects the foreign keys; all three remain in one transaction.
        await em.flush();

        if (transaction && ledgerEntry) {
          em.create(
            WagerTransactionSchema,
            toWagerRecord(transaction, null, undefined, processingContext),
          );
          await em.flush();
          em.create(WalletLedgerEntrySchema, toLedgerRecord(ledgerEntry));
          await em.flush();
        }
        enqueueEvents(em, events);
        await em.flush();
      });
      if (transaction) {
        this.observer?.record({
          event: 'transaction_committed',
          status: transaction.status,
          kind: transaction.kind,
          transactionId: transaction.id,
          walletId: wallet.id,
          providerId: transaction.providerId,
          correlationId: processingContext.correlationId,
          durationSeconds: (performance.now() - started) / 1000,
        });
      }
    } catch (error: unknown) {
      if (error instanceof UniqueConstraintViolationException) {
        const existing = await this.orm.em.fork().findOne(WalletSchema, {
          playerId: wallet.playerId,
          currency: wallet.currency,
        });
        if (existing) {
          throw new DomainError(
            'WALLET_ALREADY_EXISTS',
            'Player already has a wallet in this currency',
          );
        }
      }
      throw error;
    }
  }

  override async findById(walletId: string): Promise<Wallet | null> {
    const record = await this.orm.em
      .fork()
      .findOne(WalletSchema, { id: walletId });
    if (!record) {
      return null;
    }

    return rehydrateWallet(record);
  }
}

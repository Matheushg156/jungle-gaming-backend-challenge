import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  WalletRepository,
  type WalletOpening,
} from '../../../application/ports/wallet.repository';
import { Wallet } from '../../../domain/entities/wallet';
import { DomainError } from '../../../domain/errors/domain-error';
import { Money } from '../../../domain/value-objects/money';
import { WalletSchema } from '../schemas/wallet.schema';
import { WagerTransactionSchema } from '../schemas/wager-transaction.schema';
import { WalletLedgerEntrySchema } from '../schemas/wallet-ledger-entry.schema';

export class PostgresWalletRepository extends WalletRepository {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  override async saveOpening({
    wallet,
    transaction,
    ledgerEntry,
  }: WalletOpening): Promise<void> {
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
          em.create(WagerTransactionSchema, {
            id: transaction.id,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            idempotencyKey: transaction.idempotencyKey,
            payloadHash: transaction.payloadHash,
            walletId: transaction.walletId,
            playerId: transaction.playerId,
            roundId: transaction.roundId,
            gameId: transaction.gameId,
            kind: transaction.kind,
            amount: transaction.money.toString(),
            currency: transaction.money.currency,
            status: transaction.status,
            referenceExternalTransactionId: null,
            referenceTransactionId: null,
            failureCode: null,
            createdAt: transaction.createdAt,
            processedAt: transaction.processedAt ?? null,
          });
          await em.flush();
          em.create(WalletLedgerEntrySchema, {
            id: ledgerEntry.id,
            walletId: ledgerEntry.walletId,
            transactionId: ledgerEntry.transactionId,
            direction: ledgerEntry.direction,
            amount: ledgerEntry.money.toString(),
            currency: ledgerEntry.money.currency,
            balanceBefore: ledgerEntry.balanceBefore.toString(),
            balanceAfter: ledgerEntry.balanceAfter.toString(),
            createdAt: ledgerEntry.createdAt,
          });
          await em.flush();
        }
      });
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

    return Wallet.rehydrate({
      ...record,
      balance: Money.rehydrate({
        amount: record.balance,
        currency: record.currency,
      }),
    });
  }
}

import { randomUUID } from 'node:crypto';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction';
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import { DomainError } from '../../domain/errors/domain-error';
import { Money } from '../../domain/value-objects/money';
import {
  WageringUnitOfWork,
  type LockedWageringContext,
  type StoredWager,
} from '../ports/wagering-unit-of-work';
import { hashWagerPayload } from './hash-wager-payload';
import type {
  SubmitWagerInput,
  SubmitWagerResult,
  WagerResult,
} from './wager.contracts';

export class SubmitWager {
  constructor(private readonly unitOfWork: WageringUnitOfWork) {}

  async execute(
    input: SubmitWagerInput,
    idempotencyKey: string,
  ): Promise<SubmitWagerResult> {
    if (!/^[\x21-\x7e]{1,255}$/.test(idempotencyKey)) {
      throw new DomainError(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must contain 1 to 255 printable characters without spaces',
      );
    }
    if (
      ![
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Loss,
      ].includes(input.kind)
    ) {
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        'This stage supports BET, WIN and LOSS',
      );
    }
    if (input.providerId === '__internal__') {
      throw new DomainError(
        'INVALID_PROVIDER',
        'Internal provider identity is reserved',
      );
    }

    const transaction = WagerTransaction.create({
      ...input,
      id: randomUUID(),
      idempotencyKey,
      payloadHash: hashWagerPayload(input),
      money: Money.from(input.money),
      createdAt: new Date(),
    });

    const committed =
      await this.unitOfWork.findByIdempotencyKey(idempotencyKey);
    if (committed) {
      return this.replay(committed, transaction.payloadHash);
    }

    return this.unitOfWork.withLockedWallet(input.walletId, async (context) => {
      const existing = await context.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        return this.replay(existing, transaction.payloadHash);
      }
      if (
        await context.findByExternalId(
          input.providerId,
          input.externalTransactionId,
        )
      ) {
        throw new DomainError(
          'EXTERNAL_TRANSACTION_CONFLICT',
          'Provider transaction was already submitted with another key',
        );
      }

      const entry = await this.apply(transaction, context);
      const result: WagerResult = {
        transactionId: transaction.id,
        status: transaction.status,
        balance: context.wallet.balance.toJSON(),
        ...(transaction.failureCode
          ? { failureCode: transaction.failureCode }
          : {}),
      };
      await context.save(transaction, result, entry);
      return { ...result, idempotentReplay: false };
    });
  }

  private replay(stored: StoredWager, payloadHash: string): SubmitWagerResult {
    stored.transaction.assertReplay(payloadHash);
    if (!stored.result) {
      throw new Error('Accepted wager is missing its persisted result');
    }
    return { ...stored.result, idempotentReplay: true };
  }

  private async apply(
    transaction: WagerTransaction,
    context: LockedWageringContext,
  ): Promise<WalletLedgerEntry | undefined> {
    const wallet = context.wallet;
    if (transaction.playerId !== wallet.playerId) {
      transaction.reject('PLAYER_MISMATCH');
      return;
    }
    if (transaction.money.currency !== wallet.currency) {
      transaction.reject('CURRENCY_MISMATCH');
      return;
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId) {
      const stored = await context.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );
      if (!stored || !stored.transaction.isTerminal()) {
        transaction.markPendingReference();
        return;
      }
      reference = stored.transaction;
      try {
        transaction.validateReference(reference);
      } catch (error: unknown) {
        if (!(error instanceof DomainError)) {
          throw error;
        }
        transaction.reject(error.code);
        return;
      }
    }

    let entry: WalletLedgerEntry | undefined;
    if (transaction.affectsBalance()) {
      const movement = {
        ledgerEntryId: randomUUID(),
        transactionId: transaction.id,
        money: transaction.money,
        at: new Date(),
      };
      // Only a debit can fail with insufficient funds. Other failures abort the SQL transaction.
      if (transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit) {
        if (wallet.balance.isLessThan(transaction.money)) {
          transaction.reject('INSUFFICIENT_FUNDS');
          return;
        }
        entry = wallet.debit(movement);
      } else {
        try {
          entry = wallet.credit(movement);
        } catch (error: unknown) {
          if (
            !(error instanceof DomainError) ||
            error.code !== 'MONEY_OUT_OF_RANGE'
          ) {
            throw error;
          }
          transaction.reject('BALANCE_LIMIT_EXCEEDED');
          return;
        }
      }
    }

    transaction.markProcessed(reference?.id, new Date());
    return entry;
  }
}

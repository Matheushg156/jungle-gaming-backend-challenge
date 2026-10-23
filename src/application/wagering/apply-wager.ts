import { randomUUID } from 'node:crypto';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import {
  LedgerDirection,
  type WalletLedgerEntry,
} from '../../domain/entities/wallet-ledger-entry';
import { DomainError } from '../../domain/errors/domain-error';
import type { LockedWageringContext } from '../ports/wagering-unit-of-work';

export async function applyWager(
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
    if (!stored) {
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
      if (error.code === 'REFERENCE_NOT_PROCESSED' && !reference.isTerminal()) {
        transaction.markPendingReference();
        return;
      }
      transaction.reject(error.code);
      return;
    }
    if (
      transaction.requiresReference() &&
      (await context.hasProcessedReversal(reference.id, transaction.kind))
    ) {
      transaction.reject('REFERENCE_ALREADY_REVERSED');
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
        transaction.reject(
          transaction.requiresReference()
            ? 'REVERSAL_INSUFFICIENT_FUNDS'
            : 'INSUFFICIENT_FUNDS',
        );
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

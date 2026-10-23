import { WagerTransaction } from '../../../domain/entities/wager-transaction';
import { Money } from '../../../domain/value-objects/money';
import type { WagerResult } from '../../../application/wagering/wager.contracts';
import type { WagerTransactionRecord } from '../schemas/wager-transaction.schema';

export function rehydrateWager(
  record: WagerTransactionRecord,
): WagerTransaction {
  const {
    referenceExternalTransactionId,
    referenceTransactionId,
    failureCode,
    processedAt,
    ...state
  } = record;
  return WagerTransaction.rehydrate({
    ...state,
    money: Money.rehydrate({
      amount: record.amount,
      currency: record.currency,
    }),
    ...(referenceExternalTransactionId !== null
      ? { referenceExternalTransactionId }
      : {}),
    ...(referenceTransactionId !== null ? { referenceTransactionId } : {}),
    ...(failureCode !== null ? { failureCode } : {}),
    ...(processedAt !== null ? { processedAt } : {}),
  });
}

export function toWagerRecord(
  transaction: WagerTransaction,
  result: WagerResult | null,
): WagerTransactionRecord {
  return {
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
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
    result,
  };
}

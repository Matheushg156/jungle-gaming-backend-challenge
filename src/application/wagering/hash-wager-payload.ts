import { createHash } from 'node:crypto';
import type { SubmitWagerInput } from './wager.contracts';

export function hashWagerPayload(input: SubmitWagerInput): string {
  // Keys are explicitly sorted at both levels. Transport metadata never enters the hash.
  const canonicalPayload = JSON.stringify({
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    playerId: input.playerId,
    providerId: input.providerId,
    ...(input.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
    roundId: input.roundId,
    walletId: input.walletId,
  });

  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex');
}

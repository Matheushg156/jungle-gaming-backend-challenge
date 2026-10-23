import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import { WageringUnitOfWork } from '../ports/wagering-unit-of-work';
import { applyWager } from './apply-wager';
import { createWagerResult } from './create-wager-result';
import { ReferenceRetryPolicy } from './reference-retry-policy';

export class RetryPendingReferences {
  constructor(private readonly unitOfWork: WageringUnitOfWork) {}

  async execute(now = new Date(), limit = 50): Promise<number> {
    const candidates = await this.unitOfWork.findDueReferences(now, limit);
    let attempted = 0;
    const failures: unknown[] = [];
    for (const candidate of candidates) {
      try {
        const processed = await this.unitOfWork.withLockedWallet(
          candidate.walletId,
          async (context) => {
            const stored = await context.findByIdempotencyKey(
              candidate.idempotencyKey,
            );
            if (
              !stored ||
              stored.transaction.status !==
                WagerTransactionStatus.PendingReference ||
              !stored.referenceRetry ||
              !ReferenceRetryPolicy.isDue(stored.referenceRetry, now)
            ) {
              return false;
            }

            const transaction = stored.transaction;
            const entry = await applyWager(transaction, context);
            if (
              transaction.status === WagerTransactionStatus.PendingReference &&
              stored.referenceRetry.expiresAt <= now
            ) {
              transaction.reject('REFERENCE_NOT_FOUND');
            }
            const retry = ReferenceRetryPolicy.afterAttempt(
              stored.referenceRetry,
              now,
              transaction.status === WagerTransactionStatus.PendingReference,
            );
            await context.save(
              transaction,
              createWagerResult(transaction, context.wallet),
              entry,
              retry,
            );
            return true;
          },
        );
        if (processed) {
          attempted += 1;
        }
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    // A failing wallet must not starve the remaining candidates. Report the failure after the batch.
    if (failures.length > 0) {
      throw failures[0];
    }
    return attempted;
  }
}

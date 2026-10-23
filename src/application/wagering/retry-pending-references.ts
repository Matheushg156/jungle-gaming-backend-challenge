import { PermanentPersistenceError } from '../ports/permanent-persistence-error';
import type { ProcessingObserver } from '../ports/processing-observer';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import { WageringUnitOfWork } from '../ports/wagering-unit-of-work';
import { applyWager } from './apply-wager';
import { createWagerResult } from './create-wager-result';
import { ReferenceRetryPolicy } from './reference-retry-policy';
import { createWagerEvents } from '../events/create-wager-events';

export class RetryPendingReferences {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly observer?: ProcessingObserver,
  ) {}

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
            await context.save({
              transaction,
              result: createWagerResult(transaction, context.wallet),
              processingContext: stored.processingContext,
              events: createWagerEvents(
                transaction,
                context.wallet,
                entry,
                stored.processingContext,
                WagerTransactionStatus.PendingReference,
              ),
              ...(entry ? { entry } : {}),
              referenceRetry: retry,
            });
            return true;
          },
        );
        if (processed) {
          attempted += 1;
          this.observer?.record({
            event: 'reference_retry',
            walletId: candidate.walletId,
          });
        }
      } catch (error: unknown) {
        if (error instanceof PermanentPersistenceError) {
          try {
            if (await this.failPermanently(candidate, error.code, now)) {
              attempted += 1;
              this.observer?.record({
                event: 'reference_retry',
                walletId: candidate.walletId,
                code: error.code,
              });
            }
          } catch (auditError: unknown) {
            // If even the failure record cannot commit, preserve the accepted
            // pending operation for a later worker. Never acknowledge it in memory.
            failures.push(auditError);
          }
        } else {
          failures.push(error);
        }
      }
    }
    // A failing wallet must not starve the remaining candidates. Report the failure after the batch.
    if (failures.length > 0) {
      throw failures[0];
    }
    return attempted;
  }

  private failPermanently(
    candidate: { walletId: string; idempotencyKey: string },
    code: string,
    now: Date,
  ): Promise<boolean> {
    return this.unitOfWork.withLockedWallet(
      candidate.walletId,
      async (context) => {
        const stored = await context.findByIdempotencyKey(
          candidate.idempotencyKey,
        );
        if (
          !stored ||
          stored.transaction.status !==
            WagerTransactionStatus.PendingReference ||
          !stored.referenceRetry
        ) {
          // Another worker may have resolved it after the failed attempt rolled back.
          return false;
        }
        stored.transaction.fail(code);
        await context.save({
          transaction: stored.transaction,
          result: createWagerResult(stored.transaction, context.wallet),
          events: createWagerEvents(
            stored.transaction,
            context.wallet,
            undefined,
            stored.processingContext,
          ),
          processingContext: stored.processingContext,
          referenceRetry: ReferenceRetryPolicy.afterAttempt(
            stored.referenceRetry,
            now,
            false,
          ),
        });
        return true;
      },
    );
  }
}

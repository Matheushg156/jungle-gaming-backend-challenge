import type { ProcessingObserver } from '../ports/processing-observer';
import { randomUUID } from 'node:crypto';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/entities/wager-transaction';
import { DomainError } from '../../domain/errors/domain-error';
import { Money } from '../../domain/value-objects/money';
import {
  WageringUnitOfWork,
  type StoredWager,
  type WagerSubmissionContext,
} from '../ports/wagering-unit-of-work';
import { applyWager } from './apply-wager';
import { createWagerResult } from './create-wager-result';
import { ReferenceRetryPolicy } from './reference-retry-policy';
import { WagerTransactionStatus } from '../../domain/entities/wager-transaction';
import { hashWagerPayload } from './hash-wager-payload';
import type { SubmitWagerInput, SubmitWagerResult } from './wager.contracts';
import { createWagerEvents } from '../events/create-wager-events';

export class SubmitWager {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly observer?: ProcessingObserver,
  ) {}

  async execute(
    input: SubmitWagerInput,
    idempotencyKey: string,
    processingContext: WagerSubmissionContext = { correlationId: randomUUID() },
  ): Promise<SubmitWagerResult> {
    const started = performance.now();
    const result = await this.perform(input, idempotencyKey, processingContext);
    if (result.idempotentReplay) {
      this.observer?.record({
        event: 'wager_replayed',
        transactionId: result.transactionId,
        walletId: input.walletId,
        providerId: input.providerId,
        correlationId: processingContext.correlationId,
        ...(processingContext.inbox
          ? { messageId: processingContext.inbox.messageId }
          : {}),
        durationSeconds: (performance.now() - started) / 1000,
      });
    }
    return result;
  }

  private async perform(
    input: SubmitWagerInput,
    idempotencyKey: string,
    processingContext: WagerSubmissionContext,
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
        WagerTransactionKind.Refund,
        WagerTransactionKind.Rollback,
      ].includes(input.kind)
    ) {
      throw new DomainError(
        'UNSUPPORTED_OPERATION',
        'Unsupported wagering operation',
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

    const committed = processingContext.inbox
      ? null
      : await this.unitOfWork.findByIdempotencyKey(idempotencyKey);
    if (committed) {
      return this.replay(committed, transaction.payloadHash);
    }

    return this.unitOfWork.withLockedWallet(
      input.walletId,
      async (context) => {
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

        const entry = await applyWager(transaction, context);
        const result = createWagerResult(transaction, context.wallet);
        const retry =
          transaction.status === WagerTransactionStatus.PendingReference
            ? ReferenceRetryPolicy.initial(transaction.createdAt)
            : undefined;
        await context.save({
          transaction,
          result,
          processingContext,
          events: createWagerEvents(
            transaction,
            context.wallet,
            entry,
            processingContext,
          ),
          ...(entry ? { entry } : {}),
          ...(retry ? { referenceRetry: retry } : {}),
        });
        return { ...result, idempotentReplay: false };
      },
      processingContext.inbox,
    );
  }

  private replay(stored: StoredWager, payloadHash: string): SubmitWagerResult {
    stored.transaction.assertReplay(payloadHash);
    if (!stored.result) {
      throw new Error('Accepted wager is missing its persisted result');
    }
    return { ...stored.result, idempotentReplay: true };
  }
}

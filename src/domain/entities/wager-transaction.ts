import { DomainError } from '../errors/domain-error';
import { Money } from '../value-objects/money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface WagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface WagerTransactionState extends WagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: string;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(private state: WagerTransactionState) {}

  static create(props: WagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new DomainError(
        'INTERNAL_OPERATION',
        'OPENING must use the internal factory',
      );
    }
    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.referenceExternalTransactionId
    ) {
      throw new DomainError(
        'REFERENCE_REQUIRED',
        'Reversals require a reference',
      );
    }
    if (
      props.kind === WagerTransactionKind.Bet &&
      props.referenceExternalTransactionId
    ) {
      throw new DomainError(
        'UNEXPECTED_REFERENCE',
        'BET cannot reference another transaction',
      );
    }
    if (
      props.money.isNegative() ||
      (props.kind !== WagerTransactionKind.Loss && !props.money.isPositive())
    ) {
      throw new DomainError(
        'INVALID_TRANSACTION_AMOUNT',
        'Financial operations require a positive amount',
      );
    }
    if (props.kind === WagerTransactionKind.Loss && !props.money.isZero()) {
      throw new DomainError('INVALID_LOSS_AMOUNT', 'LOSS amount must be zero');
    }
    return new WagerTransaction({
      ...props,
      createdAt: new Date(props.createdAt),
      status: WagerTransactionStatus.Pending,
    });
  }

  static opening(
    props: Omit<
      WagerTransactionProps,
      'kind' | 'referenceExternalTransactionId'
    >,
  ): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new DomainError(
        'INVALID_TRANSACTION_AMOUNT',
        'OPENING requires a positive amount',
      );
    }
    return new WagerTransaction({
      ...props,
      createdAt: new Date(props.createdAt),
      kind: WagerTransactionKind.Opening,
      status: WagerTransactionStatus.Pending,
    });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction({
      ...state,
      createdAt: new Date(state.createdAt),
      ...(state.processedAt
        ? { processedAt: new Date(state.processedAt) }
        : {}),
    });
  }

  get id(): string {
    return this.state.id;
  }

  get providerId(): string {
    return this.state.providerId;
  }

  get externalTransactionId(): string {
    return this.state.externalTransactionId;
  }

  get idempotencyKey(): string {
    return this.state.idempotencyKey;
  }

  get payloadHash(): string {
    return this.state.payloadHash;
  }

  get walletId(): string {
    return this.state.walletId;
  }

  get playerId(): string {
    return this.state.playerId;
  }

  get roundId(): string {
    return this.state.roundId;
  }

  get gameId(): string {
    return this.state.gameId;
  }

  get kind(): WagerTransactionKind {
    return this.state.kind;
  }

  get money(): Money {
    return this.state.money;
  }

  get referenceExternalTransactionId(): string | undefined {
    return this.state.referenceExternalTransactionId;
  }

  get createdAt(): Date {
    return new Date(this.state.createdAt);
  }

  get status(): WagerTransactionStatus {
    return this.state.status;
  }

  get referenceTransactionId(): string | undefined {
    return this.state.referenceTransactionId;
  }

  get failureCode(): string | undefined {
    return this.state.failureCode;
  }

  get processedAt(): Date | undefined {
    return this.state.processedAt
      ? new Date(this.state.processedAt)
      : undefined;
  }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertMutable();
    if (
      (this.requiresReference() || this.referenceExternalTransactionId) &&
      !referenceTransactionId
    ) {
      throw new DomainError(
        'REFERENCE_REQUIRED',
        'Referenced transaction must be resolved before processing',
      );
    }
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Processed,
      processedAt: new Date(at),
      ...(referenceTransactionId ? { referenceTransactionId } : {}),
    };
  }

  markPendingReference(): void {
    this.assertMutable();
    if (!this.referenceExternalTransactionId) {
      throw new DomainError(
        'UNEXPECTED_REFERENCE',
        'Transaction has no reference to wait for',
      );
    }
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.PendingReference,
    };
  }

  reject(code: string): void {
    this.assertMutable();
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Rejected,
      failureCode: code,
    };
  }

  fail(code: string): void {
    this.assertMutable();
    this.state = {
      ...this.state,
      status: WagerTransactionStatus.Failed,
      failureCode: code,
    };
  }

  isTerminal(): boolean {
    return [
      WagerTransactionStatus.Processed,
      WagerTransactionStatus.Rejected,
      WagerTransactionStatus.Failed,
    ].includes(this.status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  assertReplay(hash: string): void {
    if (!this.matchesPayload(hash)) {
      throw new DomainError(
        'IDEMPOTENCY_CONFLICT',
        'Idempotency key was used with a different payload',
      );
    }
  }

  validateReference(reference: WagerTransaction): void {
    if (
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency ||
      reference.id === this.id
    ) {
      throw new DomainError(
        'REFERENCE_MISMATCH',
        'Reference must belong to the same provider, player, wallet, currency and round',
      );
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new DomainError(
        'REFERENCE_NOT_PROCESSED',
        'Reference must be processed',
      );
    }
    const allowed =
      this.kind === WagerTransactionKind.Rollback
        ? [
            WagerTransactionKind.Bet,
            WagerTransactionKind.Win,
            WagerTransactionKind.Refund,
          ]
        : [WagerTransactionKind.Bet];
    if (!allowed.includes(reference.kind)) {
      throw new DomainError(
        'INVALID_REFERENCE_KIND',
        'Operation cannot reference this kind',
      );
    }
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new DomainError(
        'REVERSAL_AMOUNT_MISMATCH',
        'Partial reversals are not supported',
      );
    }
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    if (!this.affectsBalance()) {
      throw new DomainError(
        'NO_LEDGER_EFFECT',
        'LOSS does not produce a ledger entry',
      );
    }
    if (this.requiresReference() || this.referenceExternalTransactionId) {
      if (!reference) {
        throw new DomainError(
          'REFERENCE_REQUIRED',
          'Reference must be resolved',
        );
      }
      this.validateReference(reference);
    }
    if (this.kind === WagerTransactionKind.Rollback) {
      return reference?.kind === WagerTransactionKind.Bet
        ? LedgerDirection.Credit
        : LedgerDirection.Debit;
    }
    return this.kind === WagerTransactionKind.Bet
      ? LedgerDirection.Debit
      : LedgerDirection.Credit;
  }

  private assertMutable(): void {
    if (this.isTerminal()) {
      throw new DomainError(
        'INVALID_TRANSACTION_STATE',
        'Terminal transaction cannot change state',
      );
    }
  }
}

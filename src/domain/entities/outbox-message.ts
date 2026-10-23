import { DomainError } from '../errors/domain-error';
import {
  freezeEventData,
  type EventEnvelope,
  type IntegrationEvent,
} from '../events/integration-event';

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: EventEnvelope;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxMessageState) {
    freezeEventData(state.payload);
  }

  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({
      ...state,
      payload: structuredClone(state.payload),
      occurredAt: new Date(state.occurredAt),
      ...(state.nextAttemptAt
        ? { nextAttemptAt: new Date(state.nextAttemptAt) }
        : {}),
      ...(state.publishedAt
        ? { publishedAt: new Date(state.publishedAt) }
        : {}),
    });
  }

  get id(): string {
    return this.state.id;
  }
  get aggregateId(): string {
    return this.state.aggregateId;
  }
  get eventType(): string {
    return this.state.eventType;
  }
  get payload(): EventEnvelope {
    return structuredClone(this.state.payload);
  }
  get occurredAt(): Date {
    return new Date(this.state.occurredAt);
  }
  get attempts(): number {
    return this.state.attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this.state.nextAttemptAt
      ? new Date(this.state.nextAttemptAt)
      : undefined;
  }
  get publishedAt(): Date | undefined {
    return this.state.publishedAt
      ? new Date(this.state.publishedAt)
      : undefined;
  }
  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }
  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (!this.state.nextAttemptAt || this.state.nextAttemptAt <= now)
    );
  }

  markPublished(at: Date): void {
    this.assertPending();
    this.state.publishedAt = new Date(at);
    delete this.state.nextAttemptAt;
  }

  scheduleRetry(now: Date): void {
    this.assertPending();
    this.state.attempts += 1;
    const delay = Math.min(
      1000 * 2 ** Math.min(this.state.attempts - 1, 20),
      300000,
    );
    this.state.nextAttemptAt = new Date(now.getTime() + delay);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new DomainError(
        'OUTBOX_ALREADY_PUBLISHED',
        'Published outbox message cannot change',
      );
    }
  }
}

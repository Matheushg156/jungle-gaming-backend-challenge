export interface IntegrationEventProps<T extends object> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

export interface EventEnvelope<T extends object = object> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export function freezeEventData(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      freezeEventData(child);
    }
    Object.freeze(value);
  }
}

export abstract class IntegrationEvent<T extends object> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly data: Readonly<T>;
  private readonly timestamp: number;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.timestamp = props.occurredAt.getTime();
    this.data = structuredClone(props.data);
    freezeEventData(this.data);
  }

  get occurredAt(): Date {
    return new Date(this.timestamp);
  }

  toJSON(): EventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data),
    };
  }
}

export type EventContext = Pick<
  IntegrationEventProps<object>,
  'eventId' | 'correlationId' | 'causationId' | 'occurredAt'
>;

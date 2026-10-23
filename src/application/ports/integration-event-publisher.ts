import type { EventEnvelope } from '../../domain/events/integration-event';

export abstract class IntegrationEventPublisher {
  abstract publish(event: EventEnvelope): Promise<void>;
}

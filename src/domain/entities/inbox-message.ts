import { DomainError } from '../errors/domain-error';

interface InboxMessageState {
  consumerName: string;
  messageId: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date | null;
}

export class InboxMessage {
  private constructor(private readonly state: InboxMessageState) {}

  static receive(state: Omit<InboxMessageState, 'processedAt'>): InboxMessage {
    if (
      !state.consumerName ||
      !state.messageId ||
      !/^[a-f0-9]{64}$/.test(state.payloadHash)
    ) {
      throw new DomainError(
        'INVALID_INBOX_MESSAGE',
        'Invalid inbox identity or hash',
      );
    }
    return InboxMessage.rehydrate(state);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage({
      ...state,
      receivedAt: new Date(state.receivedAt),
      processedAt: state.processedAt ? new Date(state.processedAt) : null,
    });
  }

  get consumerName(): string {
    return this.state.consumerName;
  }
  get messageId(): string {
    return this.state.messageId;
  }
  get payloadHash(): string {
    return this.state.payloadHash;
  }
  get receivedAt(): Date {
    return new Date(this.state.receivedAt);
  }
  get processedAt(): Date | undefined {
    return this.state.processedAt
      ? new Date(this.state.processedAt)
      : undefined;
  }

  isProcessed(): boolean {
    return !!this.state.processedAt;
  }

  assertPayload(hash: string): void {
    if (hash !== this.payloadHash) {
      throw new DomainError(
        'INBOX_MESSAGE_CONFLICT',
        'Message identity was reused with a different payload',
      );
    }
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new DomainError(
        'INBOX_ALREADY_PROCESSED',
        'Inbox message is already processed',
      );
    }
    this.state.processedAt = new Date(at);
  }
}

export interface ProcessingObservation {
  event:
    | 'transaction_committed'
    | 'wager_replayed'
    | 'processing_failed'
    | 'queue_retry'
    | 'queue_dead_lettered'
    | 'outbox_published'
    | 'outbox_retry'
    | 'reference_retry';
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  status?: string;
  kind?: string;
  code?: string;
  durationSeconds?: number;
}

export abstract class ProcessingObserver {
  abstract record(observation: ProcessingObservation): void;
}

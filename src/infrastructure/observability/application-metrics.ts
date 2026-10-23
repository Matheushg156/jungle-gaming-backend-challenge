import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { ReconciliationObserver } from '../../application/ports/reconciliation-observer';
import type {
  ProcessingObserver,
  ProcessingObservation,
} from '../../application/ports/processing-observer';
import { writeOperationalLog } from './json-logger';

@Injectable()
export class ApplicationMetrics
  extends ReconciliationObserver
  implements ProcessingObserver
{
  private readonly registry = new Registry();
  private readonly mismatches = new Counter({
    name: 'wallet_reconciliation_mismatches_total',
    help: 'Reconciliation mismatches',
    registers: [this.registry],
  });
  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Committed financial status transitions, including opening',
    labelNames: ['status', 'kind'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wager_duplicates_total',
    help: 'Detected successful replays across HTTP and SQS',
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'processing_retries_total',
    help: 'Scheduled retries by component',
    labelNames: ['component'],
    registers: [this.registry],
  });
  private readonly dlq = new Counter({
    name: 'sqs_dead_lettered_total',
    help: 'Confirmed application sends to the dead letter queue',
    registers: [this.registry],
  });
  private readonly locks = new Counter({
    name: 'database_lock_conflicts_total',
    help: 'Lock timeouts, deadlocks and serialization failures',
    labelNames: ['code'],
    registers: [this.registry],
  });
  private readonly latency = new Histogram({
    name: 'wager_processing_duration_seconds',
    help: 'Financial processing latency, including opening, failures and successful replays',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1, 5, 15],
    registers: [this.registry],
  });
  private readonly lag = new Gauge({
    name: 'outbox_lag_seconds',
    help: 'Age of the oldest unpublished committed event, zero when empty',
    registers: [this.registry],
  });
  private readonly pending = new Gauge({
    name: 'outbox_pending_messages',
    help: 'Unpublished committed events',
    registers: [this.registry],
  });

  override recordMismatch(walletId: string, correlationId: string): void {
    this.mismatches.inc();
    writeOperationalLog('warn', {
      event: 'wallet_reconciliation_mismatch',
      walletId,
      correlationId,
    });
  }

  record(observation: ProcessingObservation): void {
    const { event, status, kind, code, durationSeconds } = observation;
    if (event === 'transaction_committed' && status && kind) {
      this.transactions.inc({
        status,
        kind,
      });
    }
    if (event === 'wager_replayed') {
      this.duplicates.inc();
    }
    if (event === 'queue_retry') {
      this.retries.inc({ component: 'sqs' });
    }
    if (event === 'outbox_retry') {
      this.retries.inc({ component: 'outbox' });
    }
    if (event === 'reference_retry') {
      this.retries.inc({ component: 'reference' });
    }
    if (event === 'queue_dead_lettered') {
      this.dlq.inc();
    }
    if (
      event === 'processing_failed' &&
      code &&
      ['55P03', '40P01', '40001'].includes(code)
    ) {
      this.locks.inc({ code });
    }
    if (durationSeconds !== undefined) {
      this.latency.observe(durationSeconds);
    }
    writeOperationalLog(
      event === 'processing_failed' || event === 'queue_dead_lettered'
        ? 'warn'
        : 'info',
      { ...observation },
    );
  }

  updateOutbox(pending: number, lagSeconds: number): void {
    this.pending.set(pending);
    this.lag.set(Math.max(0, lagSeconds));
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}

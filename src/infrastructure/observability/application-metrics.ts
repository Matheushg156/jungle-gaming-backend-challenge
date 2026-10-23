import { Injectable } from '@nestjs/common';
import { Counter, Registry } from '@prometheus-io/client';
import { ReconciliationObserver } from '../../application/ports/reconciliation-observer';

@Injectable()
export class ApplicationMetrics extends ReconciliationObserver {
  private readonly registry = new Registry();
  private readonly mismatches = new Counter({
    name: 'wallet_reconciliation_mismatches_total',
    help: 'Number of wallet reconciliation checks that detected a balance mismatch',
    registers: [this.registry],
  });

  override recordMismatch(walletId: string, correlationId: string): void {
    this.mismatches.inc();
    // No balances or financial payloads are included in logs or metric labels.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'wallet_reconciliation_mismatch',
        walletId,
        correlationId,
      }),
    );
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }
}

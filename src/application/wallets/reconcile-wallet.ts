import { randomUUID } from 'node:crypto';
import { WalletReadRepository } from '../ports/wallet-read.repository';
import { ReconciliationObserver } from '../ports/reconciliation-observer';
import type { ReconciliationResult } from '../queries/query.contracts';

export class ReconcileWallet {
  constructor(
    private readonly wallets: WalletReadRepository,
    private readonly observer: ReconciliationObserver,
  ) {}

  async execute(
    walletId: string,
    correlationId: string = randomUUID(),
  ): Promise<ReconciliationResult> {
    const result = await this.wallets.reconcile(walletId);
    if (!result.consistent) {
      this.observer.recordMismatch(walletId, correlationId);
    }
    return result;
  }
}

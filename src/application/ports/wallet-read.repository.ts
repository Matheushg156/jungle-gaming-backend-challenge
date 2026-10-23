import type {
  LedgerSlice,
  ReconciliationResult,
} from '../queries/query.contracts';

export abstract class WalletReadRepository {
  abstract readLedger(
    walletId: string,
    after: string,
    through: string | null,
    limit: number,
  ): Promise<LedgerSlice>;
  abstract reconcile(walletId: string): Promise<ReconciliationResult>;
}

import type { WagerTransactionView } from '../queries/query.contracts';

export abstract class WagerReadRepository {
  abstract findById(
    transactionId: string,
  ): Promise<WagerTransactionView | null>;
  abstract findByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransactionView | null>;
}

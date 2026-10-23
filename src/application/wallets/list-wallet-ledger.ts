import { WalletReadRepository } from '../ports/wallet-read.repository';
import { DomainError } from '../../domain/errors/domain-error';
import type { LedgerPage } from '../queries/query.contracts';
import { LedgerCursor } from './ledger-cursor';

export class ListWalletLedger {
  constructor(private readonly wallets: WalletReadRepository) {}

  async execute(
    walletId: string,
    limit = 50,
    cursor?: string,
  ): Promise<LedgerPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainError(
        'INVALID_PAGE_LIMIT',
        'Limit must be an integer between 1 and 100',
      );
    }
    const position =
      cursor !== undefined ? LedgerCursor.decode(cursor, walletId) : null;
    const page = await this.wallets.readLedger(
      walletId,
      position?.after ?? '0',
      position?.through ?? null,
      limit,
    );
    return {
      items: page.items,
      nextCursor:
        page.hasMore && page.lastSequence !== null
          ? LedgerCursor.encode(
              walletId,
              page.lastSequence,
              page.snapshotSequence,
            )
          : null,
    };
  }
}

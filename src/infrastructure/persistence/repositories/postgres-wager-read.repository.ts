import { MikroORM } from '@mikro-orm/postgresql';
import { WagerReadRepository } from '../../../application/ports/wager-read.repository';
import type { WagerTransactionView } from '../../../application/queries/query.contracts';
import {
  WagerTransactionSchema,
  type WagerTransactionRecord,
} from '../schemas/wager-transaction.schema';

function toView(
  record: WagerTransactionRecord | null,
): WagerTransactionView | null {
  if (!record) {
    return null;
  }
  return {
    transactionId: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind,
    money: { amount: record.amount, currency: record.currency },
    status: record.status,
    referenceExternalTransactionId: record.referenceExternalTransactionId,
    referenceTransactionId: record.referenceTransactionId,
    failureCode: record.failureCode,
    createdAt: record.createdAt.toISOString(),
    processedAt: record.processedAt?.toISOString() ?? null,
    result: record.result,
  };
}

export class PostgresWagerReadRepository extends WagerReadRepository {
  constructor(private readonly orm: MikroORM) {
    super();
  }

  override async findById(
    transactionId: string,
  ): Promise<WagerTransactionView | null> {
    return toView(
      await this.orm.em
        .fork()
        .findOne(WagerTransactionSchema, { id: transactionId }),
    );
  }

  override async findByExternalId(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransactionView | null> {
    return toView(
      await this.orm.em.fork().findOne(WagerTransactionSchema, {
        providerId,
        externalTransactionId: externalId,
      }),
    );
  }
}

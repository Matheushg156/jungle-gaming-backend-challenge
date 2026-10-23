import { randomUUID } from 'node:crypto';
import { Wallet } from '../../domain/entities/wallet';
import {
  WalletLedgerEntry,
  LedgerDirection,
} from '../../domain/entities/wallet-ledger-entry';
import { WagerTransaction } from '../../domain/entities/wager-transaction';
import { Money, type MoneyProps } from '../../domain/value-objects/money';
import { WalletRepository } from '../ports/wallet.repository';

export interface OpenWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
}

export class OpenWallet {
  constructor(private readonly wallets: WalletRepository) {}

  async execute(input: OpenWalletInput): Promise<Wallet> {
    const initialBalance = Money.from(input.initialBalance);
    const at = new Date();
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: input.playerId,
      initialBalance,
      at,
    });

    if (initialBalance.isZero()) {
      await this.wallets.saveOpening({ wallet });
      return wallet;
    }

    const transaction = WagerTransaction.opening({
      id: randomUUID(),
      providerId: '__internal__',
      externalTransactionId: wallet.id,
      idempotencyKey: `opening:${wallet.id}`,
      payloadHash: 'internal-opening-v1',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: wallet.id,
      gameId: '__opening__',
      money: initialBalance,
      createdAt: at,
    });
    transaction.markProcessed(undefined, at);

    const ledgerEntry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: initialBalance,
      createdAt: at,
    });

    await this.wallets.saveOpening({ wallet, transaction, ledgerEntry });
    return wallet;
  }
}

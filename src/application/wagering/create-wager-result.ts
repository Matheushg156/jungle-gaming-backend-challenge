import type { Wallet } from '../../domain/entities/wallet';
import type { WagerTransaction } from '../../domain/entities/wager-transaction';
import type { WagerResult } from './wager.contracts';

export function createWagerResult(
  transaction: WagerTransaction,
  wallet: Wallet,
): WagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: wallet.balance.toJSON(),
    ...(transaction.failureCode
      ? { failureCode: transaction.failureCode }
      : {}),
  };
}

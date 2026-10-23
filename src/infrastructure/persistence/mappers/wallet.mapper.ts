import { Wallet } from '../../../domain/entities/wallet';
import { Money } from '../../../domain/value-objects/money';
import type { WalletRecord } from '../schemas/wallet.schema';

export function rehydrateWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    ...record,
    balance: Money.rehydrate({
      amount: record.balance,
      currency: record.currency,
    }),
  });
}

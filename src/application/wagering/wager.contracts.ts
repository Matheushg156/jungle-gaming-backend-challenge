import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import type { MoneyProps } from '../../domain/value-objects/money';

export interface SubmitWagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: string;
}

export interface SubmitWagerResult extends WagerResult {
  idempotentReplay: boolean;
}

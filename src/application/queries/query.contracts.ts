import type { LedgerDirection } from '../../domain/entities/wallet-ledger-entry';
import type {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/entities/wager-transaction';
import type { MoneyProps } from '../../domain/value-objects/money';
import type { WagerResult } from '../wagering/wager.contracts';

export interface LedgerEntryView {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface LedgerPage {
  items: LedgerEntryView[];
  nextCursor: string | null;
}

export interface LedgerSlice {
  items: LedgerEntryView[];
  lastSequence: string | null;
  snapshotSequence: string;
  hasMore: boolean;
}

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

export interface WagerTransactionView {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  referenceExternalTransactionId: string | null;
  referenceTransactionId: string | null;
  failureCode: string | null;
  createdAt: string;
  processedAt: string | null;
  result: WagerResult | null;
}

export abstract class ReconciliationObserver {
  abstract recordMismatch(walletId: string, correlationId: string): void;
}

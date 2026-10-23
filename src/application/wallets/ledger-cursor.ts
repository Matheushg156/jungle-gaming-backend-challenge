import { DomainError } from '../../domain/errors/domain-error';

interface CursorState {
  version: 1;
  walletId: string;
  after: string;
  through: string;
}

export class LedgerCursor {
  static encode(walletId: string, after: string, through: string): string {
    return Buffer.from(
      JSON.stringify({
        version: 1,
        walletId: walletId.toLowerCase(),
        after,
        through,
      }),
    ).toString('base64url');
  }

  static decode(cursor: string, walletId: string): CursorState {
    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) {
        throw new Error('Invalid encoding');
      }
      const parsed: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed) ||
        !('version' in parsed) ||
        parsed.version !== 1 ||
        !('walletId' in parsed) ||
        parsed.walletId !== walletId.toLowerCase() ||
        !('after' in parsed) ||
        !this.isSequence(parsed.after) ||
        !('through' in parsed) ||
        !this.isSequence(parsed.through) ||
        Object.keys(parsed).length !== 4 ||
        BigInt(parsed.after) > BigInt(parsed.through)
      ) {
        throw new Error('Invalid cursor state');
      }
      return {
        version: 1,
        walletId: walletId.toLowerCase(),
        after: parsed.after,
        through: parsed.through,
      };
    } catch {
      throw new DomainError(
        'INVALID_LEDGER_CURSOR',
        'Cursor is invalid or belongs to another wallet',
      );
    }
  }

  private static isSequence(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      /^(0|[1-9]\d{0,18})$/.test(value) &&
      BigInt(value) <= 9223372036854775807n
    );
  }
}

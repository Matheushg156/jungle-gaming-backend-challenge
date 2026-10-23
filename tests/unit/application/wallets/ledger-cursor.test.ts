import { describe, expect, test } from 'bun:test';
import { LedgerCursor } from '../../../../src/application/wallets/ledger-cursor';

const walletId = '0192f291-27dd-7d3f-8071-5f8685deef37';
const encode = (state: unknown): string =>
  Buffer.from(JSON.stringify(state)).toString('base64url');

describe('LedgerCursor', () => {
  test('round trips sequences beyond JavaScript safe integers', () => {
    const cursor = LedgerCursor.encode(
      walletId,
      '9007199254740993',
      '9223372036854775807',
    );
    expect(LedgerCursor.decode(cursor, walletId)).toEqual({
      version: 1,
      walletId,
      after: '9007199254740993',
      through: '9223372036854775807',
    });
  });

  test('normalizes the wallet scope without accepting another wallet', () => {
    const cursor = LedgerCursor.encode(walletId.toUpperCase(), '1', '10');
    expect(LedgerCursor.decode(cursor, walletId).after).toBe('1');
    expect(() =>
      LedgerCursor.decode(cursor, '0192f291-27dd-7d3f-8071-5f8685deef38'),
    ).toThrow('another wallet');
  });

  test.each([
    '',
    '!',
    'a'.repeat(513),
    encode(null),
    encode([]),
    encode({}),
    encode({ version: 2, walletId, after: '1', through: '10' }),
  ])('rejects malformed cursor %j', (cursor) => {
    expect(() => LedgerCursor.decode(cursor, walletId)).toThrow(
      'Cursor is invalid',
    );
  });

  test.each([
    { after: '-1', through: '10' },
    { after: '1.0', through: '10' },
    { after: '01', through: '10' },
    { after: '11', through: '10' },
    { after: '1', through: '9223372036854775808' },
    { after: 1, through: '10' },
  ])('rejects invalid sequence state %j', (state) => {
    expect(() =>
      LedgerCursor.decode(encode({ version: 1, walletId, ...state }), walletId),
    ).toThrow('Cursor is invalid');
  });
});

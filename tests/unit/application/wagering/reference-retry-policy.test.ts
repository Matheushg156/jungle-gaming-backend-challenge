import { describe, expect, test } from 'bun:test';
import { ReferenceRetryPolicy } from '../../../../src/application/wagering/reference-retry-policy';

const createdAt = new Date('2026-01-01T00:00:00.000Z');

describe('ReferenceRetryPolicy', () => {
  test('starts after one second and expires after 24 hours', () => {
    const state = ReferenceRetryPolicy.initial(createdAt);
    expect(state.attempts).toBe(0);
    expect(state.nextAttemptAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z');
    expect(state.expiresAt.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(ReferenceRetryPolicy.isDue(state, createdAt)).toBe(false);
    expect(
      ReferenceRetryPolicy.isDue(state, new Date('2026-01-01T00:00:01.000Z')),
    ).toBe(true);
  });

  test('doubles the delay and caps it at five minutes', () => {
    const initial = ReferenceRetryPolicy.initial(createdAt);
    const second = ReferenceRetryPolicy.afterAttempt(initial, createdAt, true);
    expect(second.attempts).toBe(1);
    expect(second.nextAttemptAt?.getTime()).toBe(createdAt.getTime() + 2000);
    const capped = ReferenceRetryPolicy.afterAttempt(
      { ...initial, attempts: 100 },
      createdAt,
      true,
    );
    expect(capped.nextAttemptAt?.getTime()).toBe(createdAt.getTime() + 300000);
    expect(initial.attempts).toBe(0);
  });

  test('never schedules beyond expiration', () => {
    const state = ReferenceRetryPolicy.initial(createdAt);
    const now = new Date(state.expiresAt.getTime() - 500);
    const next = ReferenceRetryPolicy.afterAttempt(state, now, true);
    expect(next.nextAttemptAt).toEqual(state.expiresAt);
    expect(ReferenceRetryPolicy.isDue(next, state.expiresAt)).toBe(true);
  });

  test('clears the next attempt when the transaction becomes terminal', () => {
    const state = ReferenceRetryPolicy.afterAttempt(
      ReferenceRetryPolicy.initial(createdAt),
      createdAt,
      false,
    );
    expect(state.nextAttemptAt).toBeNull();
    expect(state.attempts).toBe(1);
  });
});

export interface ReferenceRetryState {
  attempts: number;
  nextAttemptAt: Date | null;
  expiresAt: Date;
}

export class ReferenceRetryPolicy {
  static readonly ttlMs = 24 * 60 * 60 * 1000;
  private static readonly maximumDelayMs = 5 * 60 * 1000;

  static initial(createdAt: Date): ReferenceRetryState {
    return {
      attempts: 0,
      nextAttemptAt: new Date(createdAt.getTime() + 1000),
      expiresAt: new Date(createdAt.getTime() + this.ttlMs),
    };
  }

  static isDue(state: ReferenceRetryState, now: Date): boolean {
    return (
      state.expiresAt <= now ||
      (state.nextAttemptAt !== null && state.nextAttemptAt <= now)
    );
  }

  static afterAttempt(
    state: ReferenceRetryState,
    now: Date,
    stillPending: boolean,
  ): ReferenceRetryState {
    const attempts = state.attempts + 1;
    const delay = Math.min(
      1000 * 2 ** Math.min(attempts, 20),
      this.maximumDelayMs,
    );
    return {
      attempts,
      nextAttemptAt: stillPending
        ? new Date(Math.min(now.getTime() + delay, state.expiresAt.getTime()))
        : null,
      expiresAt: new Date(state.expiresAt),
    };
  }
}

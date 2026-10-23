/** A deterministic persistence failure, after rollback of the attempted write. */
export class PermanentPersistenceError extends Error {
  readonly code = 'PERSISTENCE_INTEGRITY_FAILURE';

  constructor() {
    super(
      'Persistence integrity prevented processing; transaction rolled back',
    );
  }
}

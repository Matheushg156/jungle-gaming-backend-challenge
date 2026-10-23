import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors/domain-error';

export function readCorrelationId(header: string | undefined): string {
  if (header === undefined) {
    return randomUUID();
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(header)) {
    throw new DomainError(
      'INVALID_CORRELATION_ID',
      'X-Correlation-Id must contain 1 to 128 letters, digits, dots, underscores, colons or hyphens',
    );
  }
  return header;
}

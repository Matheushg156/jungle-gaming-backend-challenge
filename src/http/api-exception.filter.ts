import { PermanentPersistenceError } from '../application/ports/permanent-persistence-error';
import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { DriverException } from '@mikro-orm/core';
import { DomainError } from '../domain/errors/domain-error';

interface ErrorResponse {
  status(code: number): ErrorResponse;
  json(body: unknown): void;
}

@Catch(DomainError, DriverException, PermanentPersistenceError)
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(
    error: DomainError | DriverException | PermanentPersistenceError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<ErrorResponse>();
    if (error instanceof DomainError) {
      const conflicts = [
        'IDEMPOTENCY_CONFLICT',
        'EXTERNAL_TRANSACTION_CONFLICT',
        'TRANSACTION_IDENTITY_CONFLICT',
        'WALLET_ALREADY_EXISTS',
      ];
      const status = conflicts.includes(error.code)
        ? 409
        : ['WALLET_NOT_FOUND', 'TRANSACTION_NOT_FOUND'].includes(error.code)
          ? 404
          : 400;
      response
        .status(status)
        .json({ code: error.code, message: error.message });
      return;
    }

    const transientCodes = [
      '40001',
      '40P01',
      '55P03',
      '57014',
      '57P01',
      '57P02',
      '57P03',
      '53300',
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
    ];
    const transient =
      error.code?.startsWith('08') || transientCodes.includes(error.code ?? '');
    // Never expose driver SQL or parameters in HTTP responses or logs.
    this.logger.error({
      code: transient ? 'DATABASE_UNAVAILABLE' : 'DATABASE_ERROR',
    });
    response.status(transient ? 503 : 500).json({
      code: transient ? 'DATABASE_UNAVAILABLE' : 'INTERNAL_ERROR',
      message: transient
        ? 'Database temporarily unavailable; retry with the same idempotency key'
        : 'Unexpected persistence failure',
    });
  }
}

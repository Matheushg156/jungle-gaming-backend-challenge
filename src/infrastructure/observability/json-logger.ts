import type { LoggerService } from '@nestjs/common';

// Nest messages may contain unknown objects, including exceptions. Only emit
// explicitly selected operational fields, never arbitrary error/driver objects.
export function writeOperationalLog(
  level: string,
  fields: Record<string, unknown>,
): void {
  console.log(
    JSON.stringify({ timestamp: new Date().toISOString(), level, ...fields }),
  );
}

export class JsonLogger implements LoggerService {
  log(message: unknown): void {
    this.write('info', message);
  }
  error(message: unknown): void {
    this.write('error', message);
  }
  warn(message: unknown): void {
    this.write('warn', message);
  }
  debug(message: unknown): void {
    this.write('debug', message);
  }
  verbose(message: unknown): void {
    this.write('debug', message);
  }

  private write(level: string, message: unknown): void {
    if (typeof message === 'string') {
      writeOperationalLog(level, { message });
    } else if (message && typeof message === 'object') {
      const safe: Record<string, unknown> = {};
      for (const name of [
        'code',
        'event',
        'component',
        'count',
        'correlationId',
        'messageId',
        'transactionId',
        'walletId',
        'providerId',
      ]) {
        if (name in message) {
          safe[name] = (message as Record<string, unknown>)[name];
        }
      }
      writeOperationalLog(level, safe);
    }
  }
}

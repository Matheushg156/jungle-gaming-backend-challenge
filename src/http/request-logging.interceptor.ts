import { randomUUID } from 'node:crypto';
import {
  Injectable,
  type NestInterceptor,
  type ExecutionContext,
  type CallHandler,
} from '@nestjs/common';
import { tap } from 'rxjs';
import { writeOperationalLog } from '../infrastructure/observability/json-logger';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<{
      method: string;
      headers: Record<string, string | string[] | undefined>;
    }>();
    const incoming = request.headers['x-correlation-id'];
    const correlationId =
      typeof incoming === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/.test(incoming)
        ? incoming
        : randomUUID();
    if (incoming === undefined) {
      request.headers['x-correlation-id'] = correlationId;
    }
    const started = performance.now();
    const log = (event: string) =>
      writeOperationalLog('info', {
        event,
        correlationId,
        method: request.method,
        handler: `${context.getClass().name}.${context.getHandler().name}`,
        durationSeconds: (performance.now() - started) / 1000,
      });
    return next.handle().pipe(
      tap({
        next: () => log('http_completed'),
        error: () => log('http_failed'),
      }),
    );
  }
}

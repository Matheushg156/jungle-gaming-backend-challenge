import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccessTokenVerifier } from '../application/ports/access-token-verifier';
import { WagerReadRepository } from '../application/ports/wager-read.repository';
import { AUTH_ENABLED } from '../infrastructure/auth/auth.tokens';

const OPERATOR_ONLY = 'operator-only';
export const OperatorOnly = () => SetMetadata(OPERATOR_ONLY, true);

@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  constructor(
    @Inject(AUTH_ENABLED) private readonly enabled: boolean,
    @Inject(AccessTokenVerifier) private readonly verifier: AccessTokenVerifier,
    @Inject(WagerReadRepository) private readonly wagers: WagerReadRepository,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string };
      params: Record<string, string | undefined>;
      body?: unknown;
    }>();
    const header = request.headers.authorization;
    if (
      typeof header !== 'string' ||
      header.length > 16384 ||
      !/^Bearer \S+$/i.test(header)
    ) {
      throw new UnauthorizedException('Bearer access token required');
    }
    const principal = await this.verifier.verify(header.slice(7));
    if (principal.operator) {
      return true;
    }
    if (
      this.reflector.getAllAndOverride<boolean>(OPERATOR_ONLY, [
        context.getHandler(),
        context.getClass(),
      ]) ||
      !principal.providerId
    ) {
      throw new ForbiddenException('Insufficient permissions');
    }
    const body = request.body;
    const bodyProvider =
      body && typeof body === 'object' && 'providerId' in body
        ? body.providerId
        : undefined;
    if (
      (typeof bodyProvider === 'string' &&
        bodyProvider !== principal.providerId) ||
      (request.params.providerId !== undefined &&
        request.params.providerId !== principal.providerId)
    ) {
      throw new ForbiddenException(
        'Provider identity does not match the access token',
      );
    }
    const id = request.params.transactionId;
    if (
      id &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ) {
      const transaction = await this.wagers.findById(id);
      if (transaction && transaction.providerId !== principal.providerId) {
        throw new ForbiddenException('Transaction belongs to another provider');
      }
    }
    return true;
  }
}

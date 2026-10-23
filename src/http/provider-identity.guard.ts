import { CanActivate, Injectable } from '@nestjs/common';

/** Extension point for future OIDC provider identity validation. Local challenge only. */
@Injectable()
export class ProviderIdentityGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

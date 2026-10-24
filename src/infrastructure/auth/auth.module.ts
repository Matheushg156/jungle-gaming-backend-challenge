import { Module } from '@nestjs/common';
import { AccessTokenVerifier } from '../../application/ports/access-token-verifier';
import { ProviderIdentityGuard } from '../../http/provider-identity.guard';
import { OidcTokenVerifier } from './oidc-token-verifier';
import { PersistenceModule } from '../persistence/persistence.module';

import { AUTH_ENABLED } from './auth.tokens';

@Module({
  imports: [PersistenceModule],
  providers: [
    ProviderIdentityGuard,
    {
      provide: AUTH_ENABLED,
      useFactory: () => {
        const value = process.env.AUTH_ENABLED ?? 'true';
        if (!['true', 'false'].includes(value)) {
          throw new Error('AUTH_ENABLED must be true or false');
        }
        return value === 'true';
      },
    },
    {
      provide: AccessTokenVerifier,
      useFactory: () =>
        new OidcTokenVerifier(
          process.env.OIDC_ISSUER ?? 'http://localhost:8080/realms/jungle',
          process.env.OIDC_AUDIENCE ?? 'wagering-api',
          process.env.OIDC_JWKS_URI ??
            'http://localhost:8080/realms/jungle/protocol/openid-connect/certs',
        ),
    },
  ],
  exports: [ProviderIdentityGuard, AUTH_ENABLED, AccessTokenVerifier],
})
export class AuthModule {}

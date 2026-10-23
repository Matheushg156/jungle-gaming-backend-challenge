import { createRemoteJWKSet, jwtVerify, errors } from 'jose';
import {
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AccessTokenVerifier,
  type ProviderPrincipal,
} from '../../application/ports/access-token-verifier';

export class OidcTokenVerifier extends AccessTokenVerifier {
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;
  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    jwksUri: string,
  ) {
    super();
    if (!audience.trim() || audience !== audience.trim()) {
      throw new Error(
        'OIDC audience must be a non-empty identifier without surrounding whitespace',
      );
    }
    const url = new URL(jwksUri);
    for (const value of [url, new URL(issuer)]) {
      if (
        !['http:', 'https:'].includes(value.protocol) ||
        value.username ||
        value.password
      ) {
        throw new Error(
          'OIDC issuer and JWKS must be HTTP(S) URLs without credentials',
        );
      }
    }
    this.keys = createRemoteJWKSet(url, {
      timeoutDuration: 2000,
      cooldownDuration: 5000,
      cacheMaxAge: 600000,
    });
  }

  override async verify(token: string): Promise<ProviderPrincipal> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      });
      if (
        payload.typ !== 'Bearer' ||
        typeof payload.sub !== 'string' ||
        !payload.sub
      ) {
        throw new UnauthorizedException('An access token is required');
      }
      const access = payload.realm_access;
      const roles =
        access &&
        typeof access === 'object' &&
        'roles' in access &&
        Array.isArray(access.roles)
          ? access.roles
          : [];
      const provider = payload.provider_id;
      const operator = roles.includes('operator');
      return Object.freeze({
        subject: payload.sub,
        operator,
        ...(roles.includes('provider') &&
        typeof provider === 'string' &&
        /^[\x21-\x7e]{1,255}$/.test(provider) &&
        provider !== '__internal__'
          ? { providerId: provider }
          : {}),
      });
    } catch (error: unknown) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      if (
        error instanceof errors.JOSEError &&
        ![
          'ERR_JWKS_TIMEOUT',
          'ERR_JWKS_INVALID',
          'ERR_JWK_INVALID',
          'ERR_JOSE_GENERIC',
        ].includes(error.code)
      ) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      // Neither tokens nor upstream response bodies enter logs or HTTP errors.
      throw new ServiceUnavailableException(
        'Identity provider keys temporarily unavailable',
      );
    }
  }
}

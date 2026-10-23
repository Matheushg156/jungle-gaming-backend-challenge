import { rejects } from 'node:assert/strict';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import {
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OidcTokenVerifier } from '../../src/infrastructure/auth/oidc-token-verifier';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let server: ReturnType<typeof Bun.serve>;
let verifier: OidcTokenVerifier;
beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  const publicKey = {
    ...(await exportJWK(keys.publicKey)),
    kid: 'test-key',
    alg: 'RS256',
    use: 'sig',
  };
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ keys: [publicKey] }),
  });
  verifier = new OidcTokenVerifier(
    'https://issuer.test/realm',
    'wagering-api',
    new URL('jwks', server.url).href,
  );
});
afterAll(async () => {
  await server?.stop(true);
});
async function token(overrides: Record<string, unknown> = {}) {
  return new SignJWT({
    typ: 'Bearer',
    realm_access: { roles: ['provider'] },
    provider_id: 'provider-a',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setSubject('service-a')
    .setIssuer('https://issuer.test/realm')
    .setAudience('wagering-api')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}
test('verifies a remote key and derives provider identity only from verified claims', async () => {
  expect(await verifier.verify(await token())).toEqual({
    subject: 'service-a',
    operator: false,
    providerId: 'provider-a',
  });
  expect(
    await verifier.verify(
      await token({
        realm_access: { roles: ['operator'] },
        provider_id: undefined,
      }),
    ),
  ).toEqual({ subject: 'service-a', operator: true });
});
test.each([
  'expired',
  'audience',
  'issuer',
  'no-expiration',
  'id-token',
  'tampered',
  'algorithm',
])('rejects %s tokens', async (scenario) => {
  let jwt;
  const claims = new SignJWT({ typ: scenario === 'id-token' ? 'ID' : 'Bearer' })
    .setSubject('test')
    .setIssuedAt()
    .setIssuer(
      scenario === 'issuer'
        ? 'https://other.test'
        : 'https://issuer.test/realm',
    )
    .setAudience(scenario === 'audience' ? 'wrong-api' : 'wagering-api');
  if (scenario !== 'no-expiration') {
    claims.setExpirationTime(
      scenario === 'expired' ? Math.floor(Date.now() / 1000) - 60 : '5m',
    );
  }
  if (scenario === 'algorithm') {
    jwt = await claims
      .setProtectedHeader({ alg: 'HS256' })
      .sign(new TextEncoder().encode('test-secret-of-at-least-32-characters'));
  } else {
    jwt = await claims
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .sign(keys.privateKey);
  }
  if (scenario === 'tampered') {
    const parts = jwt.split('.');
    parts[1] = Buffer.from(
      JSON.stringify({ typ: 'Bearer', realm_access: { roles: ['operator'] } }),
    ).toString('base64url');
    jwt = parts.join('.');
  }
  await rejects(verifier.verify(jwt), UnauthorizedException);
});
test('an unavailable JWKS endpoint fails closed with 503', async () => {
  const endpoint = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(null),
  });
  const url = endpoint.url.href;
  await endpoint.stop(true);
  await rejects(
    new OidcTokenVerifier(
      'https://issuer.test/realm',
      'wagering-api',
      url,
    ).verify(await token()),
    ServiceUnavailableException,
  );
});

test('an empty audience cannot silently disable audience validation', () => {
  expect(
    () =>
      new OidcTokenVerifier(
        'https://issuer.test',
        '',
        'https://issuer.test/jwks',
      ),
  ).toThrow('OIDC audience');
});

test('an upstream JWKS server error is unavailable rather than an invalid user token', async () => {
  const endpoint = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('upstream failure', { status: 503 }),
  });
  try {
    await rejects(
      new OidcTokenVerifier(
        'https://issuer.test/realm',
        'wagering-api',
        endpoint.url.href,
      ).verify(await token()),
      ServiceUnavailableException,
    );
  } finally {
    await endpoint.stop(true);
  }
});

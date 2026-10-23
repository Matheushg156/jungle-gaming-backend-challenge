import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../src/app.module';
import { createTestDatabase } from '../support/postgres-test-database';

const issuer = process.env.TEST_OIDC_ISSUER;
const suite = issuer ? describe : describe.skip;
suite('Real Keycloak service-account authentication and authorization', () => {
  let app: INestApplication;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let base: string;
  let operator: string;
  let providerA: string;
  let providerB: string;
  let walletId: string;
  const playerId = randomUUID();
  const envNames = [
    'AUTH_ENABLED',
    'OIDC_ISSUER',
    'OIDC_JWKS_URI',
    'OIDC_AUDIENCE',
    'DATABASE_URL',
  ] as const;
  let previous: Record<string, string | undefined>;
  async function accessToken(clientId: string, clientSecret: string) {
    const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(`Keycloak token request failed: ${response.status}`);
    }
    return ((await response.json()) as { access_token: string }).access_token;
  }
  beforeAll(async () => {
    previous = Object.fromEntries(
      envNames.map((name) => [name, process.env[name]]),
    );
    database = await createTestDatabase();
    process.env.DATABASE_URL = database.url;
    process.env.AUTH_ENABLED = 'true';
    process.env.OIDC_ISSUER = issuer;
    process.env.OIDC_JWKS_URI = `${issuer}/protocol/openid-connect/certs`;
    process.env.OIDC_AUDIENCE = 'wagering-api';
    [operator, providerA, providerB] = await Promise.all([
      accessToken('demo-operator', 'operator-local-secret'),
      accessToken('demo-provider-a', 'provider-a-local-secret'),
      accessToken('demo-provider-b', 'provider-b-local-secret'),
    ]);
    app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const initial = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${operator}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    if (initial.status !== 201) {
      throw new Error('Operator failed to create authentication test wallet');
    }
    walletId = ((await initial.json()) as { id: string }).id;
  }, 30000);
  afterAll(async () => {
    await app?.close();
    await database?.close();
    for (const name of envNames) {
      if (previous?.[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = previous[name];
      }
    }
  });
  const headers = (jwt: string) => ({
    authorization: `Bearer ${jwt}`,
    'content-type': 'application/json',
  });
  test('health is public and business routes reject missing or invalid credentials', async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    expect([200, 503]).toContain((await fetch(`${base}/health/ready`)).status);
    expect((await fetch(`${base}/wallets/${randomUUID()}`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/wallets/${randomUUID()}`, {
          headers: headers('invalid'),
        })
      ).status,
    ).toBe(401);
  });
  test('only the operator may create/read wallets or scrape metrics', async () => {
    const body = JSON.stringify({
      playerId: randomUUID(),
      initialBalance: { amount: '100.00', currency: 'BRL' },
    });
    expect(
      (
        await fetch(`${base}/wallets`, {
          method: 'POST',
          headers: headers(providerA),
          body,
        })
      ).status,
    ).toBe(403);
    const created = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: headers(operator),
      body,
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toHaveProperty('id');
    expect(
      (
        await fetch(`${base}/wallets/${walletId}`, {
          headers: headers(providerA),
        })
      ).status,
    ).toBe(403);
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${base}/metrics`, { headers: headers(providerA) })).status,
    ).toBe(403);
    expect(
      (await fetch(`${base}/metrics`, { headers: headers(operator) })).status,
    ).toBe(200);
  });
  test('a provider can submit and replay its operation but cannot impersonate or query another provider', async () => {
    const input = {
      providerId: 'provider-a',
      externalTransactionId: 'auth-bet',
      playerId,
      walletId,
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const post = (jwt: string, providerId: string) =>
      fetch(`${base}/wagering/transactions`, {
        method: 'POST',
        headers: { ...headers(jwt), 'idempotency-key': 'provider-a:auth-bet' },
        body: JSON.stringify({ ...input, providerId }),
      });
    expect((await post(providerB, 'provider-a')).status).toBe(403);
    const accepted = await post(providerA, 'provider-a');
    expect(accepted.status).toBe(200);
    const id = ((await accepted.json()) as { transactionId: string })
      .transactionId;
    expect(await (await post(providerA, 'provider-a')).json()).toMatchObject({
      idempotentReplay: true,
    });
    expect(
      (
        await fetch(`${base}/wagering/transactions/${id}`, {
          headers: headers(providerA),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/wagering/transactions/${id}`, {
          headers: headers(providerB),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${base}/providers/provider-a/wagering/transactions/auth-bet`,
          { headers: headers(providerB) },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(
          `${base}/providers/provider-a/wagering/transactions/auth-bet`,
          { headers: headers(providerA) },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${base}/wallets/${walletId}`, {
          headers: headers(operator),
        })
      ).status,
    ).toBe(200);
    const reconciliation = await fetch(
      `${base}/wallets/${walletId}/reconciliation`,
      { method: 'POST', headers: headers(operator) },
    );
    expect(await reconciliation.json()).toMatchObject({
      consistent: true,
      storedBalance: { amount: '90.00' },
    });
  });
});

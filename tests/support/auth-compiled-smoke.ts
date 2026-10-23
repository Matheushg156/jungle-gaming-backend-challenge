import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from './postgres-test-database';

async function token(clientId: string, clientSecret: string) {
  const response = await fetch(
    'http://localhost:8080/realms/jungle/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
  );
  assert.equal(
    response.status,
    200,
    'Keycloak must issue a service account token',
  );
  return ((await response.json()) as { access_token: string }).access_token;
}
async function run() {
  const [operator, provider] = await Promise.all([
    token('demo-operator', 'operator-local-secret'),
    token('demo-provider-a', 'provider-a-local-secret'),
  ]);
  const database = await createTestDatabase();
  const server = Bun.spawn([process.execPath, 'dist/main.js'], {
    env: {
      ...process.env,
      DATABASE_URL: database.url,
      PORT: '3108',
      AUTH_ENABLED: 'true',
      OIDC_ISSUER: 'http://localhost:8080/realms/jungle',
      OIDC_AUDIENCE: 'wagering-api',
      OIDC_JWKS_URI:
        'http://localhost:8080/realms/jungle/protocol/openid-connect/certs',
      REFERENCE_RECOVERY_ENABLED: 'false',
      OUTBOX_PUBLISHER_ENABLED: 'false',
      SQS_CONSUMER_ENABLED: 'false',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = new Response(server.stdout).text();
  const errors = new Response(server.stderr).text();
  const base = 'http://127.0.0.1:3108';
  const headers = (jwt: string) => ({
    authorization: `Bearer ${jwt}`,
    'content-type': 'application/json',
  });
  try {
    let live = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        live = (await fetch(`${base}/health/live`)).status === 200;
      } catch {
        /* starting */
      }
      if (live) {
        break;
      }
      await Bun.sleep(100);
    }
    assert.ok(live, 'Compiled app must start');
    assert.equal((await fetch(`${base}/wallets/${randomUUID()}`)).status, 401);
    const playerId = randomUUID();
    const created = await fetch(`${base}/wallets`, {
      method: 'POST',
      headers: headers(operator),
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: '100.00', currency: 'BRL' },
      }),
    });
    assert.equal(created.status, 201);
    const walletId = ((await created.json()) as { id: string }).id;
    const body = {
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      walletId,
      playerId,
      roundId: 'auth-smoke',
      gameId: 'game',
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    };
    const key = randomUUID();
    const post = (providerId: string) =>
      fetch(`${base}/wagering/transactions`, {
        method: 'POST',
        headers: { ...headers(provider), 'idempotency-key': key },
        body: JSON.stringify({ ...body, providerId }),
      });
    assert.equal((await post('provider-b')).status, 403);
    assert.equal((await post('provider-a')).status, 200);
    assert.equal(
      (
        (await (await post('provider-a')).json()) as {
          idempotentReplay: boolean;
        }
      ).idempotentReplay,
      true,
    );
    assert.equal(
      (
        await fetch(`${base}/wallets/${walletId}`, {
          headers: headers(provider),
        })
      ).status,
      403,
    );
    const reconciled = await fetch(
      `${base}/wallets/${walletId}/reconciliation`,
      { method: 'POST', headers: headers(operator) },
    );
    const state = (await reconciled.json()) as {
      consistent: boolean;
      storedBalance: { amount: string };
    };
    assert.ok(state.consistent);
    assert.equal(state.storedBalance.amount, '90.00');
  } finally {
    server.kill('SIGTERM');
    assert.ok([0, 143].includes(await server.exited));
    const logs = (await output) + (await errors);
    assert.ok(
      !logs.includes(operator) && !logs.includes(provider),
      'Tokens must not appear in runtime logs',
    );
    await database.close();
  }
  console.log(
    'Authenticated compiled app smoke passed: real Keycloak, authorization, replay, reconciliation and SIGTERM',
  );
}
run().catch(() => {
  console.error('Authenticated compiled app smoke failed');
  process.exitCode = 1;
});

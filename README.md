# Jungle Gaming — Distributed Wagering Processor

Serviço financeiro para processar apostas recebidas por HTTP ou SQS. Suporta BET, WIN, LOSS, REFUND e ROLLBACK, com idempotência persistente, ledger imutável e recuperação após falhas.

A implementação usa Bun, TypeScript estrito, NestJS, MikroORM, PostgreSQL e SQS via LocalStack. A autenticação externa usa Keycloak.

- [Decisões de arquitetura](ARCHITECTURE.md)
- [Autenticação e tokens](AUTHENTICATION.md)
- [Collection Bruno](bruno/jungle-gaming/README.md)

## Executar localmente

Requisitos: Bun 1.x e Docker com Compose. A aplicação roda no host; PostgreSQL, LocalStack e Keycloak rodam em containers.

```sh
bun install --frozen-lockfile
```

Na primeira execução, crie o arquivo de configuração. Se já existir um `.env`, atualize-o usando `.env.example` como referência.

```sh
cp .env.example .env
```

Inicie os serviços, aplique as migrations e execute a API:

```sh
docker compose --profile auth up -d --wait postgres localstack keycloak
bun run migration:up
bun run dev
```

| Serviço    | Endereço local        |
| ---------- | --------------------- |
| API        | http://localhost:3000 |
| Keycloak   | http://localhost:8080 |
| PostgreSQL | localhost:5432        |
| LocalStack | http://localhost:4566 |

O Bun carrega `.env` automaticamente. O Compose importa o realm do Keycloak e cria as três filas SQS. As credenciais de exemplo são exclusivas para desenvolvimento; não é necessária uma conta AWS.

Para executar o JavaScript compilado, substitua `bun run dev` por:

```sh
bun run build
bun run start:prod
```

As migrations são explícitas e versionadas. `bun run migration:down` reverte a última migration e pode remover dados; não é um comando para desfazer uma operação financeira.

## Testar a API com Bruno

Abra a pasta `bruno/jungle-gaming` na extensão do Bruno ou no aplicativo desktop e selecione o ambiente **Local**. Execute as 27 requisições em ordem, sem paralelismo.

A collection obtém tokens, cria uma wallet e salva os IDs automaticamente. Demonstra apostas, replay, conflitos, permissões, reversões, paginação e reconciliação. Tokens ficam apenas em memória. O [guia da collection](bruno/jungle-gaming/README.md) explica como repetir o fluxo.

A API exige `Authorization: Bearer <access_token>`. Use token de operador para wallets e métricas; use token de provedor para suas transações. O [guia de autenticação](AUTHENTICATION.md) contém as contas locais e o passo a passo para Bruno, Postman ou curl.

## Endpoints

| Método | Rota                                                                  | Acesso                              |
| ------ | --------------------------------------------------------------------- | ----------------------------------- |
| GET    | `/health/live`                                                        | Público                             |
| GET    | `/health/ready`                                                       | Público                             |
| POST   | `/wallets`                                                            | Operador                            |
| GET    | `/wallets/:walletId`                                                  | Operador                            |
| GET    | `/wallets/:walletId/ledger?limit=50&cursor=...`                       | Operador                            |
| POST   | `/wallets/:walletId/reconciliation`                                   | Operador                            |
| POST   | `/wagering/transactions`                                              | Provedor correspondente ou operador |
| GET    | `/wagering/transactions/:transactionId`                               | Provedor correspondente ou operador |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Provedor correspondente ou operador |
| GET    | `/metrics`                                                            | Operador                            |

### Criar wallet e submeter aposta

Obtenha os tokens conforme o guia de autenticação e defina `OPERATOR_TOKEN` e `PROVIDER_TOKEN` no terminal. Use o token de `demo-provider-a` para o exemplo de aposta.

```sh
curl -i http://localhost:3000/wallets \
  -H "Authorization: Bearer $OPERATOR_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"550e8400-e29b-41d4-a716-446655440000","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

A criação retorna `201`. Copie o `id` da resposta para `WALLET_ID`. Reutilizar jogador e moeda na criação retorna `409`; use outro UUID para uma nova wallet.

```sh
curl -i http://localhost:3000/wagering/transactions \
  -H "Authorization: Bearer $PROVIDER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-001' \
  -H 'X-Correlation-Id: demo-round-001' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"bet-001\",\"playerId\":\"550e8400-e29b-41d4-a716-446655440000\",\"walletId\":\"$WALLET_ID\",\"roundId\":\"round-001\",\"gameId\":\"game-001\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

Reenviar a mesma key e payload retorna o resultado original com `idempotentReplay: true`. Alterar o payload mantendo a key gera conflito. Valores monetários são sempre strings com duas casas decimais.

| Operação | Efeito e regra                                          |
| -------- | ------------------------------------------------------- |
| BET      | Debita valor positivo; rejeita saldo insuficiente       |
| WIN      | Credita valor positivo; pode referenciar uma BET        |
| LOSS     | Registra resultado com valor `0.00`, sem lançamento     |
| REFUND   | Devolve integralmente uma BET processada                |
| ROLLBACK | Inverte integralmente uma BET, WIN ou REFUND processada |

REFUND e ROLLBACK exigem `referenceExternalTransactionId`. A referência deve pertencer ao mesmo provedor, jogador, wallet, moeda e rodada. Cada referência admite uma reversão por tipo. OPENING é interno e só é criado para saldo inicial positivo.

| HTTP      | Significado                                           |
| --------- | ----------------------------------------------------- |
| 200       | Operação processada ou replay de processamento        |
| 202       | Operação aceita, aguardando referência                |
| 400       | Payload ou idempotency key inválidos                  |
| 401 / 403 | Credencial inválida/ausente ou permissão insuficiente |
| 404       | Recurso inexistente                                   |
| 409       | Conflito de identidade ou idempotência                |
| 422       | Rejeição por regra de negócio, com `failureCode`      |
| 500       | Falha interna ou replay de uma operação FAILED        |
| 503       | Falha transitória de infraestrutura                   |

### Ledger e reconciliação

O ledger retorna `{ "items": [...], "nextCursor": "..." }`. O limite padrão é 50, com intervalo de 1 a 100. Envie `nextCursor` na próxima consulta da mesma wallet até receber null. Novas movimentações aparecem ao iniciar outra paginação.

A reconciliação não recebe body e não corrige dados. Ela compara saldo armazenado com a soma do ledger e retorna `storedBalance`, `calculatedBalance`, `difference`, `consistent` e `checkedEntries`. Uma divergência é sinalizada na resposta, no log e em métrica.

## Entrada SQS

| Fila                          | Finalidade                                |
| ----------------------------- | ----------------------------------------- |
| `wager-transactions.fifo`     | Receber operações                         |
| `wager-transactions-dlq.fifo` | Preservar entregas inválidas ou esgotadas |
| `wager-events.fifo`           | Publicar eventos confirmados              |

O consumidor usa o mesmo caso de uso HTTP. A mensagem tem o envelope abaixo; `data` contém os campos da submissão HTTP e a `idempotencyKey`. Substitua os IDs pelos de uma wallet existente.

```json
{
  "messageId": "msg-bet-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-24T12:00:00.000Z",
  "correlationId": "round-001",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-001",
    "idempotencyKey": "provider-a:bet-001",
    "playerId": "550e8400-e29b-41d4-a716-446655440000",
    "walletId": "SUBSTITUA_PELO_ID_DA_WALLET",
    "roundId": "round-001",
    "gameId": "game-001",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Ao enviar pelo SDK/CLI SQS, informe também `MessageGroupId` e `MessageDeduplicationId`; walletId e messageId são escolhas adequadas. A inbox usa o messageId do corpo, não o identificador atribuído pelo broker.

O ack ocorre após commit. Erros transitórios usam backoff; erros permanentes ou o quinto recebimento encaminham a mensagem à DLQ. O corpo original e atributos de diagnóstico são preservados. Referências ausentes já aceitas são recuperadas pelo worker financeiro, sem manter a entrega na fila.

Para criar as filas em um LocalStack que já estava em execução antes desta configuração:

```sh
docker compose exec localstack sh /etc/localstack/init/ready.d/ready.sh
```

## Health e métricas

`/health/live` indica que o processo atende. `/health/ready` verifica PostgreSQL e as três filas SQS, retornando `200` ou `503`. Health checks não exigem autenticação.

`/metrics` expõe transições por status, duplicatas, retries, DLQ, conflitos de lock, latência, backlog/atraso da outbox e divergências de reconciliação. Logs JSON incluem correlação e identificadores disponíveis, sem tokens, SQL ou payloads financeiros completos. As limitações de medição estão em [ARCHITECTURE.md](ARCHITECTURE.md#observabilidade).

## Testes e verificações

```sh
bun run lint
bun run typecheck
bun run format:check
bun run test:unit
bun run build
```

Para integração, inicie PostgreSQL e LocalStack de testes:

```sh
docker compose --profile test up -d --wait postgres-test localstack-test
bun run test:integration
```

`TEST_DATABASE_URL` deve apontar para o banco dedicado `jungle_test`, com permissão para criar bancos. Cada teste ou suíte cria um banco temporário e o remove ao terminar. As filas também são exclusivas dos testes. As portas padrão são 5433 e 4567.

A suíte cobre constraints, atomicidade, replay, saldo disputado, três processos simultâneos, publishers concorrentes, retry/DLQ, SIGKILL, SIGTERM e recuperação de reversões após reinício. No preload, autenticação e workers são desabilitados; testes específicos os habilitam.

Para validar autenticação com tokens de um Keycloak real:

```sh
docker compose --profile auth up -d --wait keycloak
bun run test:auth
```

A suíte de integração inclui os testes de assinatura e claims. Os testes com Keycloak real só são habilitados por `TEST_OIDC_ISSUER`, definido no script `test:auth`. Para executar toda a integração com eles incluídos:

```sh
TEST_OIDC_ISSUER=http://localhost:8080/realms/jungle bun run test:integration
```

Há dois testes de ponta a ponta da aplicação compilada, que usam bancos temporários:

```sh
bun run build
bun tests/support/compiled-app-smoke.ts
bun tests/support/auth-compiled-smoke.ts
```

O primeiro habilita os workers e exercita HTTP/SQS sem autenticação; o segundo usa Keycloak real. As portas 3107 e 3108 precisam estar livres.

## Configuração e limites

Consulte [.env.example](.env.example) para as URLs e credenciais locais. Os flags `REFERENCE_RECOVERY_ENABLED`, `OUTBOX_PUBLISHER_ENABLED` e `SQS_CONSUMER_ENABLED` controlam os workers. `AUTH_ENABLED` é true por padrão; false é uma opção explícita para execução local sem autenticação.

O PostgreSQL de desenvolvimento usa volume persistente. LocalStack e Keycloak são efêmeros: recriá-los perde mensagens locais e altera as chaves do IdP. Eventos já marcados como publicados não são republicados automaticamente após perda da fila.

Teste de carga, OpenTelemetry, dashboard e ledger de partidas dobradas não fazem parte desta versão. Os custos e limites das garantias implementadas estão descritos em [ARCHITECTURE.md](ARCHITECTURE.md).

# Autenticação externa

A API usa Keycloak para autenticar provedores e operadores. Este guia explica como obter tokens e testar as permissões localmente.

## Iniciar

Prepare o `.env` conforme o [setup do projeto](README.md#executar-localmente). Se ele já existir, confira os campos `AUTH_ENABLED`, `OIDC_ISSUER`, `OIDC_AUDIENCE` e `OIDC_JWKS_URI` em `.env.example`. A autenticação é habilitada por padrão.

```sh
bun install --frozen-lockfile
docker compose --profile auth up -d --wait postgres localstack keycloak
bun run migration:up
bun run build
bun run start:prod
```

Keycloak fica em http://localhost:8080. Console administrativo: usuário `local-admin`, senha `local-admin-only`. O realm `jungle` é importado automaticamente. A aplicação continua em http://localhost:3000. A autenticação usa service accounts, sem login de jogador, password grant ou tabela de senhas na aplicação.

Essas contas são exclusivas para demonstração local:

| Client ID       | Client secret           | Permissão                                              |
| --------------- | ----------------------- | ------------------------------------------------------ |
| demo-operator   | operator-local-secret   | Wallets, reconciliação, métricas e todas as transações |
| demo-provider-a | provider-a-local-secret | Submeter e consultar transações de provider-a          |
| demo-provider-b | provider-b-local-secret | Submeter e consultar transações de provider-b          |

## Collection pronta para Bruno

Copie `bruno/jungle-gaming/environments/Local.bru` para `bruno/jungle-gaming/environments/Local.local.bru`. Abra a pasta `bruno/jungle-gaming` na extensão do Bruno e selecione **Local.local** em cada aba. Esse arquivo guarda os tokens e IDs e é ignorado pelo Git.

Execute as 27 requisições em ordem. A collection obtém os tokens e preenche os IDs automaticamente. O [guia do Bruno](bruno/jungle-gaming/README.md) descreve os cenários e como repetir o fluxo.

## Emitir token no Bruno/Postman

Crie uma requisição POST para:

```text
http://localhost:8080/realms/jungle/protocol/openid-connect/token
```

Use body do tipo **application/x-www-form-urlencoded**:

| Campo         | Valor para operador   |
| ------------- | --------------------- |
| grant_type    | client_credentials    |
| client_id     | demo-operator         |
| client_secret | operator-local-secret |

A resposta contém `access_token` e `expires_in`. Copie `access_token` para uma variável local da collection e selecione autorização **Bearer Token** nas requisições da API. Não use o client secret como Bearer token. Gere outra requisição de token com demo-provider-a / provider-a-local-secret para as apostas.

Para obter o mesmo token pelo terminal:

```sh
curl -sS http://localhost:8080/realms/jungle/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'client_id=demo-operator' \
  --data-urlencode 'client_secret=operator-local-secret'
```

Use na API:

```http
Authorization: Bearer SEU_ACCESS_TOKEN
```

Os exemplos do [README](README.md#criar-wallet-e-submeter-aposta) usam token de operador para criar a wallet e token de `demo-provider-a` para apostar. No payload da aposta, envie `providerId: "provider-a"`: o identificador do provedor é diferente do client ID usado no Keycloak.

## Demonstrar autorização

1. GET /health/live sem token: 200. GET /health/ready sem token: 200 quando PostgreSQL e SQS estiverem prontos.
2. POST /wallets sem token: 401; com token de provedor: 403; com operador: 201 para uma wallet nova.
3. POST /wagering/transactions com provider-a e token de demo-provider-a: processamento normal.
4. Reenvie a mesma key e payload com o mesmo token: replay normal, sem outro débito.
5. Troque o token por demo-provider-b mantendo providerId=provider-a: 403 e nenhum efeito financeiro.
6. GET /wagering/transactions/TRANSACTION_ID: provider-a pode consultar a sua transação; provider-b recebe 403.
7. GET /providers/provider-a/wagering/transactions/EXTERNAL_ID também rejeita o token de provider-b.
8. GET /wallets/WALLET_ID, ledger, reconciliação e /metrics exigem operador.

Tokens locais expiram em cinco minutos. Em 401 por expiração, obtenha outro token. 503 na validação indica que as chaves do IdP não estão disponíveis e não há chave utilizável em cache. A API valida RS256, assinatura, issuer, audience, expiração e identidade; alterar o payload do JWT não concede acesso.

## Testar

Os testes financeiros usam `AUTH_ENABLED=false` para exercitar as regras de negócio separadamente da autenticação. Os testes abaixo verificam também a integração com o IdP e as permissões da API.

```sh
docker compose --profile test up -d --wait postgres-test localstack-test
docker compose --profile auth up -d --wait keycloak
bun run test:auth
bun run test:integration
bun run test:unit
# Smoke do JavaScript compilado com Keycloak real (porta 3108 livre):
bun run build
bun tests/support/auth-compiled-smoke.ts
```

Use `TEST_DATABASE_URL` e `TEST_SQS_ENDPOINT` de `.env.example`. O comando `test:auth` emite tokens no Keycloak e testa as permissões com PostgreSQL real. Os testes do verificador usam uma chave isolada para simular tokens inválidos, expirados e indisponibilidade do JWKS.

O teste da aplicação compilada verifica autorização, replay, reconciliação, ausência de tokens nos logs e encerramento com SIGTERM. Na suíte geral, os cenários com Keycloak são habilitados por `TEST_OIDC_ISSUER`; o script `test:auth` já define essa variável.

## Limites locais

- O serviço é B2B: provedores acessam transações; operador administra wallets compartilhadas. Não há portal ou login de jogadores.
- O SQS permanece interno e não exige tokens; domínio e idempotência continuam sendo aplicados.
- O Keycloak local é efêmero. Recriar seu container importa o realm novamente e gera novas chaves. Não reutilize seus segredos em produção.
- Alterar o JSON de realm não atualiza automaticamente um realm já existente. Para reaplicar apenas o IdP local: `docker compose --profile auth up -d --force-recreate --wait keycloak`.
- As URLs usam localhost:8080 porque a API roda no host. Para containerizar a API será necessário configurar issuer e URL JWKS de forma coerente com a rede e o emissor anunciado.
- `AUTH_ENABLED=false` permite executar a API localmente sem autenticação. Não utilize esse modo para expor a API publicamente.

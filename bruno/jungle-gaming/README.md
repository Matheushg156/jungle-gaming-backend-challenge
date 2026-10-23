# Collection Bruno — Jungle Gaming

Collection em formato .bru para o Bruno e sua extensão no VS Code. Requer a branch de extras com autenticação, API e Keycloak em execução. Não é uma collection para a main sem autenticação.

## Preparar os serviços

Na raiz do projeto:

```sh
bun install --frozen-lockfile
docker compose --profile auth up -d --wait postgres localstack keycloak
bun run migration:up
bun run build
bun run start:prod
```

Mantenha esse terminal aberto para os logs. Confira os campos de autenticação em .env.example; AUTH_ENABLED deve estar true. O guia completo fica em [AUTHENTICATION.md](../../AUTHENTICATION.md).

## Abrir no VS Code

No painel da extensão Bruno, use a ação para abrir uma collection existente e selecione **esta pasta** (`bruno/jungle-gaming`), que contém `bruno.json`. Não selecione somente um arquivo de request nem a pasta environments. Depois selecione o ambiente **Local**.

O ambiente configura baseUrl=http://localhost:3000 e issuer=http://localhost:8080/realms/jungle. Se a API usar outra porta, ajuste baseUrl no ambiente. A collection utiliza scripts compatíveis com o sandbox seguro; não requer módulos externos ou acesso a arquivos.

Execute as requisições na ordem numérica ou rode a collection inteira de forma sequencial. Não use execução paralela: as requisições seguintes usam tokens e IDs criados pelas anteriores.

## Sequência de demonstração

| Requisições | Cenário                                     | Resultado                                             |
| ----------- | ------------------------------------------- | ----------------------------------------------------- |
| 01–02       | Liveness/readiness sem token                | 200; banco e SQS prontos                              |
| 03–05       | Tokens de operador, provider-a e provider-b | Tokens salvos no runtime                              |
| 06          | Criação da wallet                           | Novo jogador, saldo 100.00 e walletId salvo           |
| 07–08       | BET de 25.00 e replay                       | Saldo 75.00; um único débito                          |
| 09          | Mesma key com valor diferente               | 409 esperado                                          |
| 10          | BET de 80.00 com apenas 75.00               | 422 esperado; sem movimento                           |
| 11–15       | Saldo, ledger paginado e consultas da BET   | Saldo 75.00; dois lançamentos                         |
| 16–19       | Sem token, impersonação e permissões        | 401/403 esperados                                     |
| 20–21       | REFUND e replay                             | Saldo 100.00; um único crédito                        |
| 22–23       | Reconciliação e métricas                    | Saldo consistente e métricas acessíveis pelo operador |
| 24–26       | WIN, LOSS e ROLLBACK do WIN                 | 110.00, 110.00 e 100.00                               |
| 27          | Reconciliação final                         | Saldo 100.00; cinco lançamentos                       |

Os resultados 401, 403, 409 e 422 fazem parte da demonstração e contam como sucesso nos testes quando coincidem com o esperado.

## Variáveis automáticas

As requisições de token usam bru.setVar, sem persistência em disco. A criação da wallet gera runId e playerId novos usando UUIDs e salva walletId. A BET salva transactionId; a paginação salva ledgerCursor. Não é preciso copiar IDs ou tokens manualmente.

As credenciais do ambiente são as contas públicas de demonstração do realm local. Não coloque credenciais reais nesse arquivo. Tokens não são gravados na collection nem em environment files.

Os tokens expiram em cinco minutos. Se aparecer 401 no meio da apresentação, execute novamente 03–05 e continue. Para iniciar uma nova demonstração, execute 06 e depois 07–27 em ordem; as wallets anteriores permanecem no banco. Isso evita limpar ou sobrescrever dados.

As assertions de saldo são para a ordem acima. Executar consultas intermediárias depois do fluxo completo pode produzir falha de assertion porque o saldo já mudou. Da mesma forma, executar 07 outra vez retorna replay: use 08 para demonstrar esse comportamento.

## CLI opcional

Caso tenha o Bruno CLI instalado, execute nesta pasta:

```sh
bru run --env Local
```

A extensão não precisa do CLI instalado para enviar as requisições. A collection foi preparada para a API HTTP; os cenários SQS, concorrência e morte de processos continuam nos testes descritos em PRESENTATION.md.

## Diagnóstico

- Erro de conexão: confira a API na porta configurada em Local e mantenha `bun run start:prod` em execução.
- 503 no readiness: confira PostgreSQL, LocalStack, filas e URLs do .env.
- Falha em 03–05: confira Keycloak na porta 8080 e a importação do realm jungle.
- Variáveis vazias: selecione Local e execute as requisições anteriores que geram os dados.
- Erro de confiança/scripts na extensão: os scripts desta collection local geram IDs e capturam os campos da resposta; habilite sua execução para utilizar o fluxo automático.

# Jungle Gaming — Distributed Wagering Processor

Implementação incremental do desafio técnico de processamento distribuído de apostas.

## Estado atual

Base NestJS com TypeScript estrito e Bun, domínio financeiro, PostgreSQL com MikroORM, migrations reversíveis e abertura transacional de wallet. Disponíveis: `POST /wallets`, `GET /wallets/:walletId` e `POST /wagering/transactions` para BET, WIN, LOSS, REFUND e ROLLBACK, com idempotência persistente, concorrência por wallet e recuperação de referências. As consultas de transações, o ledger paginado e a reconciliação também estão disponíveis. SQS, inbox, outbox, health checks e as demais métricas e logs ainda estão pendentes.

## Requisitos locais

- Bun 1.x.
- Docker com Compose para PostgreSQL; LocalStack será adicionado com a mensageria.

## Execução

```sh
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d --wait postgres
bun run migration:up
bun run dev
```

O Bun carrega `.env` automaticamente. `PORT` é opcional e usa `3000` por padrão. `DATABASE_URL` é obrigatório. As credenciais do exemplo são exclusivas para desenvolvimento local. Migrations são executadas explicitamente, sem sincronização automática de schema. `bun run migration:down` reverte a última migration e remove suas tabelas e dados; use somente quando essa remoção for desejada.

```sh
curl -i http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

A criação retorna `201`; duplicação de jogador/moeda retorna `409`; entrada inválida retorna `400`. A consulta retorna `200` ou `404` para wallet inexistente. A autenticação está adiada: o guard atual permite as requisições e é o ponto de extensão para um IdP externo.

```sh
bun run lint
bun run test:unit
bun run typecheck
bun run format:check
bun run build
bun run start:prod
```

`build` usa o compilador TypeScript para emitir JavaScript com metadados de decorators, utilizados pela injeção de dependências do NestJS.

Os testes unitários usam o runner do Bun e ficam em `tests/unit`, espelhando a estrutura de `src`. Cobrem precisão monetária, invariantes da wallet, aritmética do ledger, referências, transições e comparação do hash de payload.

Para testes de integração com PostgreSQL real:

```sh
docker compose --profile test up -d --wait postgres-test
bun run test:integration
# Todos os testes (exige também o banco de testes):
bun run test
```

`TEST_DATABASE_URL` deve apontar para o banco dedicado `jungle_test`, com permissão de criar bancos. Cada execução cria um banco temporário exclusivo e o remove ao terminar, sem limpar o banco configurado. O container de testes usa armazenamento temporário e porta 5433. Os testes verificam migrations up/down, constraints, falha durante abertura, duplicação concorrente, leitura após reconexão e validação HTTP. Também verificam apostas concorrentes, 50 duplicatas em três processos independentes, replay com saldo original, rollback de aposta e progresso de wallets distintas. Cobrem também reversões, recuperadores concorrentes, agenda persistente, expiração e worker agendado real. Cobrem consultas por provedor, páginas estáveis do ledger, reconciliação concorrente e detecção de divergências com log e métrica. Ainda não cobrem SQS, morte forçada de workers ou outbox.

## Organização das pastas

```text
src/
  main.ts
  app.module.ts
  application/
    ports/          # Contratos necessários aos casos de uso
    wallets/        # Abertura, paginação e reconciliação
    queries/        # Contratos de leitura
    wagering/       # Submissão e contratos das apostas
  domain/
    entities/       # Wallet (aggregate root), transações e lançamentos
    value-objects/  # Money
    errors/         # Erros de domínio
  http/
    wallets/        # Controllers, DTOs e módulo HTTP
    wagering/       # Entrada HTTP de apostas
  infrastructure/
    persistence/    # Conexão, schemas, repositories e migrations
    workers/        # Agendamento da recuperação de referências
    observability/  # Registro e exposição de métricas
tests/
  integration/      # PostgreSQL real, HTTP e concorrência
  support/          # Banco isolado e protocolo dos processos de teste
  unit/
    application/
    domain/
      entities/
      value-objects/
```

O domínio concentra as regras e não importa NestJS ou infraestrutura. A aplicação usa um contrato de persistência; o módulo NestJS conecta esse contrato ao repository PostgreSQL. A mensageria será adicionada na sua etapa.

## Próximas etapas

1. Domínio financeiro e testes unitários — base implementada.
2. PostgreSQL, MikroORM, migrations e abertura de wallet — implementados.
3. BET, WIN e LOSS por HTTP, idempotência e concorrência — implementados.
4. REFUND, ROLLBACK e recuperação de referências — implementados.
5. Consultas e reconciliação — implementadas.
6. SQS, inbox, outbox e recuperação de falhas.
7. Observabilidade, testes distribuídos e documentação final.

As decisões e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

## Submeter aposta

Use o ID da wallet retornado na criação:

```sh
curl -i http://localhost:3000/wagering/transactions \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: provider-a:bet-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"bet-1","playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","walletId":"SUBSTITUA_PELO_ID_DA_WALLET","roundId":"round-1","gameId":"game-1","kind":"BET","money":{"amount":"25.00","currency":"BRL"}}'
```

WIN exige valor positivo; LOSS usa `0.00`. Respostas: 200 processada, 202 referência pendente, 400 entrada inválida, 404 wallet inexistente, 409 conflito de identidade/idempotência, 422 rejeição de negócio e 503 indisponibilidade transitória. Reenvie a mesma key e payload após falha transitória. Um replay retorna o saldo observado originalmente, mesmo após outras movimentações.

WIN e LOSS podem referenciar uma BET com `referenceExternalTransactionId`. REFUND exige referência a BET; ROLLBACK exige referência a BET, WIN ou REFUND. O valor da reversão deve ser integral. Repetir a mesma operação faz replay; outra reversão do mesmo tipo sobre a mesma referência é rejeitada com REFERENCE_ALREADY_REVERSED.

Referências ausentes são persistidas como pendentes. O worker roda a cada segundo, com backoff de 1 segundo até 5 minutos e expiração após 24 horas. O estado sobrevive a reinícios. `REFERENCE_RECOVERY_ENABLED=false` desativa apenas o agendamento. Referências ainda indisponíveis na checagem de expiração geram REFERENCE_NOT_FOUND. Reversão sem saldo usa REVERSAL_INSUFFICIENT_FUNDS.

A regra de uma reversão por tipo permite um REFUND e um ROLLBACK da mesma BET; essa interpretação está documentada em ARCHITECTURE.md. Eventos de integração e outbox também estão pendentes, portanto o desafio ainda não está completo.

## Consultas e reconciliação

```sh
curl http://localhost:3000/wagering/transactions/TRANSACTION_ID
curl http://localhost:3000/providers/provider-a/wagering/transactions/bet-1
curl 'http://localhost:3000/wallets/WALLET_ID/ledger?limit=50'
curl -X POST http://localhost:3000/wallets/WALLET_ID/reconciliation
curl http://localhost:3000/metrics
```

As consultas retornam 200; recursos inexistentes retornam 404; identificadores ou parâmetros inválidos retornam 400. A consulta de transação inclui `result`, com o snapshot persistido do processamento, ou null para OPENING. Não expõe hash ou idempotency key.

O ledger retorna `{ "items": [...], "nextCursor": "..." }`. O limite padrão é 50 e aceita de 1 a 100 entradas. Siga `nextCursor` no parâmetro `cursor` da mesma wallet até receber null. A ordem segue a sequência de inserção do ledger. As páginas mantêm o limite capturado na primeira consulta: novas movimentações aparecem ao iniciar outra paginação. O cursor é opaco, vinculado à wallet e não deve ser interpretado ou montado pelo cliente.

A reconciliação retorna saldo armazenado, soma calculada do ledger, `difference = storedBalance - calculatedBalance`, `consistent` e `checkedEntries`. Não altera dados. Uma divergência retorna 200 com `consistent: false`, gera log JSON sem valores financeiros e incrementa `wallet_reconciliation_mismatches_total`, exposto em `/metrics`. Aceita `X-Correlation-Id` opcional (até 128 letras, dígitos, pontos, underscores, dois-pontos ou hífens); quando ausente, gera um UUID.

A métrica conta verificações com divergência por processo, sem labels por wallet, e reinicia com o processo. A instrumentação completa do desafio será adicionada na etapa de observabilidade.

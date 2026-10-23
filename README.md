# Jungle Gaming — Distributed Wagering Processor

Implementação incremental do desafio técnico de processamento distribuído de apostas.

## Estado atual

Base NestJS com TypeScript estrito e Bun, domínio financeiro, PostgreSQL com MikroORM, migrations reversíveis e abertura transacional de wallet. Disponíveis: `POST /wallets`, `GET /wallets/:walletId` e `POST /wagering/transactions` para BET, WIN, LOSS, REFUND e ROLLBACK, com idempotência persistente, concorrência por wallet e recuperação de referências. Demais consultas, reconciliação, SQS, inbox, outbox e observabilidade ainda estão pendentes.

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

`TEST_DATABASE_URL` deve apontar para o banco dedicado `jungle_test`, com permissão de criar bancos. Cada execução cria um banco temporário exclusivo e o remove ao terminar, sem limpar o banco configurado. O container de testes usa armazenamento temporário e porta 5433. Os testes verificam migrations up/down, constraints, falha durante abertura, duplicação concorrente, leitura após reconexão e validação HTTP. Também verificam apostas concorrentes, 50 duplicatas em três processos independentes, replay com saldo original, rollback de aposta e progresso de wallets distintas. Cobrem também reversões, recuperadores concorrentes, agenda persistente, expiração e worker agendado real. Ainda não cobrem SQS, morte forçada de workers ou outbox.

## Organização das pastas

```text
src/
  main.ts
  app.module.ts
  application/
    ports/          # Contratos necessários aos casos de uso
    wallets/        # Abertura de wallet
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
5. Consultas restantes e reconciliação.
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

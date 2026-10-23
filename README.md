# Jungle Gaming — Distributed Wagering Processor

Implementação incremental do desafio técnico de processamento distribuído de apostas.

## Estado atual

Base NestJS com TypeScript estrito e Bun, domínio financeiro, PostgreSQL com MikroORM, migrations reversíveis e abertura transacional de wallet. Disponíveis: `POST /wallets` e `GET /wallets/:walletId`. Processamento de apostas, demais consultas, SQS, inbox, outbox e observabilidade ainda não estão implementados.

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

Os testes unitários usam o runner do Bun e ficam em `tests/unit/domain`, espelhando a estrutura de `src/domain`. Cobrem precisão monetária, invariantes da wallet, aritmética do ledger, referências, transições e comparação do hash de payload.

Para testes de integração com PostgreSQL real:

```sh
docker compose --profile test up -d --wait postgres-test
bun run test:integration
# Todos os testes (exige também o banco de testes):
bun run test
```

`TEST_DATABASE_URL` deve apontar para o banco dedicado `jungle_test`, com permissão de criar bancos. Cada execução cria um banco temporário exclusivo e o remove ao terminar, sem limpar o banco configurado. O container de testes usa armazenamento temporário e porta 5433. Os testes verificam migrations up/down, constraints, falha durante abertura, duplicação concorrente, leitura após reconexão e validação HTTP. Ainda não cobrem SQS ou múltiplos processos.

## Organização das pastas

```text
src/
  main.ts
  app.module.ts
  application/
    ports/          # Contratos necessários aos casos de uso
    wallets/        # Abertura de wallet
  domain/
    entities/       # Wallet (aggregate root), transações e lançamentos
    value-objects/  # Money
    errors/         # Erros de domínio
  http/
    wallets/        # Controllers, DTOs e módulo HTTP
  infrastructure/
    persistence/    # Conexão, schemas, repositories e migrations
tests/
  integration/      # PostgreSQL real e HTTP
  unit/
    domain/
      entities/
      value-objects/
```

O domínio concentra as regras e não importa NestJS ou infraestrutura. A aplicação usa um contrato de persistência; o módulo NestJS conecta esse contrato ao repository PostgreSQL. A mensageria será adicionada na sua etapa.

## Próximas etapas

1. Domínio financeiro e testes unitários — base implementada.
2. PostgreSQL, MikroORM, migrations e abertura de wallet — implementados.
3. Processamento HTTP, idempotência e concorrência.
4. SQS, inbox, outbox e recuperação de falhas.
5. Observabilidade, testes distribuídos e documentação final.

As decisões e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

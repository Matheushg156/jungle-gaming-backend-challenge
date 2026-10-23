# Jungle Gaming — Distributed Wagering Processor

Implementação incremental do desafio técnico de processamento distribuído de apostas.

## Estado atual

Base NestJS com TypeScript estrito e execução em Bun, com as classes de domínio Money, Wallet, WalletLedgerEntry e WagerTransaction e seus testes unitários. Endpoints, processamento transacional, PostgreSQL e SQS ainda não estão implementados.

## Requisitos locais

- Bun 1.x.
- Docker com Compose para as próximas etapas de PostgreSQL e LocalStack.

## Execução

```sh
bun install --frozen-lockfile
cp .env.example .env
bun run dev
```

O Bun carrega `.env` automaticamente. `PORT` é opcional e usa `3000` por padrão. Nesta etapa, a aplicação inicia sem rotas; uma requisição HTTP retorna `404`.

```sh
bun run lint
bun run test
bun run typecheck
bun run format:check
bun run build
bun run start:prod
```

`build` usa o compilador TypeScript para emitir JavaScript com metadados de decorators, utilizados pela injeção de dependências do NestJS.

Os testes unitários usam o runner do Bun e ficam em `tests/unit/domain`, espelhando a estrutura de `src/domain`. Cobrem precisão monetária, invariantes da wallet, aritmética do ledger, referências, transições e comparação do hash de payload. `bun run test:unit` executa apenas essa categoria; `bun run test` executa todos os testes. Ainda não há testes de integração ou concorrência real.

## Organização das pastas

```text
src/
  main.ts
  app.module.ts
  domain/
    entities/       # Wallet (aggregate root), transações e lançamentos
    value-objects/  # Money
    errors/         # Erros de domínio
tests/
  unit/
    domain/
      entities/
      value-objects/
```

O domínio concentra as regras e não importa NestJS ou infraestrutura. As camadas de aplicação, HTTP, persistência e mensageria serão criadas conforme forem implementadas.

## Próximas etapas

1. Domínio financeiro e testes unitários — base implementada.
2. PostgreSQL, MikroORM, migrations e abertura de wallet.
3. Processamento HTTP, idempotência e concorrência.
4. SQS, inbox, outbox e recuperação de falhas.
5. Observabilidade, testes distribuídos e documentação final.

As decisões e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

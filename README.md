# Jungle Gaming — Distributed Wagering Processor

Implementação incremental do desafio técnico de processamento distribuído de apostas.

## Estado atual

Base NestJS com TypeScript estrito e execução em Bun. As regras financeiras, endpoints, PostgreSQL e SQS ainda não estão implementados.

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
bun run typecheck
bun run format:check
bun run build
bun run start:prod
```

`build` usa o compilador TypeScript para emitir JavaScript com metadados de decorators, utilizados pela injeção de dependências do NestJS.

Ainda não há testes automatizados: eles serão introduzidos com as primeiras regras de domínio e executados pelo runner do Bun. A inicialização HTTP é verificada como smoke test nesta etapa.

## Próximas etapas

1. Domínio financeiro e testes unitários.
2. PostgreSQL, MikroORM, migrations e abertura de wallet.
3. Processamento HTTP, idempotência e concorrência.
4. SQS, inbox, outbox e recuperação de falhas.
5. Observabilidade, testes distribuídos e documentação final.

As decisões e limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md).

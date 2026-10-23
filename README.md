# Jungle Gaming — Distributed Wagering Processor

Implementação incremental do desafio técnico de processamento distribuído de apostas.

Branch de extras: autenticação OIDC habilitada por padrão. Consulte [AUTHENTICATION.md](AUTHENTICATION.md) para emitir tokens de demonstração e autorizar as requisições. Os exemplos financeiros precisam do header Authorization descrito nesse guia.

## Estado atual

Base NestJS com TypeScript estrito e Bun, domínio financeiro, PostgreSQL com MikroORM, migrations reversíveis e abertura transacional de wallet. Disponíveis: `POST /wallets`, `GET /wallets/:walletId` e `POST /wagering/transactions` para BET, WIN, LOSS, REFUND e ROLLBACK, com idempotência persistente, concorrência por wallet e recuperação de referências. As consultas de transações, o ledger paginado e a reconciliação também estão disponíveis. Eventos e outbox são persistidos atomicamente e publicados em SQS via LocalStack. O consumidor SQS, a inbox persistente e retry/DLQ também estão implementados. Health checks, logs JSON e métricas operacionais estão implementados. As limitações e decisões de escopo estão em ARCHITECTURE.md.

## Requisitos locais

- Bun 1.x.
- Docker com Compose para PostgreSQL e LocalStack SQS.

## Execução

```sh
bun install --frozen-lockfile
cp .env.example .env
docker compose --profile auth up -d --wait postgres localstack keycloak
bun run migration:up
bun run dev
```

O Bun carrega `.env` automaticamente. `PORT` é opcional e usa `3000` por padrão. `DATABASE_URL` é obrigatório. As credenciais do exemplo são exclusivas para desenvolvimento local. Migrations são executadas explicitamente, sem sincronização automática de schema. `bun run migration:down` reverte a última migration e remove suas tabelas e dados; use somente quando essa remoção for desejada.

```sh
curl -i http://localhost:3000/wallets \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

A criação retorna `201`; duplicação de jogador/moeda retorna `409`; entrada inválida retorna `400`. A consulta retorna `200` ou `404` para wallet inexistente. Nesta branch de extras, os endpoints financeiros exigem Bearer tokens do Keycloak. Wallets e métricas exigem operador; submissão e consulta de transações aceitam o provedor correspondente. Veja AUTHENTICATION.md antes de executar os exemplos HTTP abaixo.

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
docker compose --profile test up -d --wait postgres-test localstack-test
bun run test:integration
# Todos os testes (exige também o banco de testes):
bun run test
```

`TEST_DATABASE_URL` deve apontar para o banco dedicado `jungle_test`, com permissão de criar bancos. Cada execução cria um banco temporário exclusivo e o remove ao terminar, sem limpar o banco configurado. O PostgreSQL de testes usa armazenamento temporário e porta 5433. O LocalStack de testes usa porta 4567 (`TEST_SQS_ENDPOINT`); cada teste de outbox cria e remove sua própria fila FIFO. Os testes verificam migrations up/down, constraints, falha durante abertura, duplicação concorrente, leitura após reconexão e validação HTTP. Também verificam apostas concorrentes, 50 duplicatas em três processos independentes, replay com saldo original, rollback de aposta e progresso de wallets distintas. Cobrem também reversões, recuperadores concorrentes, agenda persistente, expiração e worker agendado real. Cobrem consultas por provedor, páginas estáveis do ledger, reconciliação concorrente e detecção de divergências com log e métrica. A suíte de outbox usa LocalStack real para publicação, concorrência, backoff, recuperação após reconexão e reenvio após falha entre envio e commit. A suíte de entrada cobre inbox, retry/DLQ, 50 duplicatas em três consumidores Bun independentes, morte por SIGKILL após commit antes do ack e conclusão da mensagem durante SIGTERM. Workers agendados ficam desabilitados por padrão no preload de testes; testes específicos os habilitam.

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
  contracts/        # DTO de submissão compartilhado entre HTTP e SQS
  domain/
    entities/       # Wallet (aggregate root), transações e lançamentos
    value-objects/  # Money
    errors/         # Erros de domínio
    events/         # Envelope e eventos financeiros
  http/
    wallets/        # Controllers, DTOs e módulo HTTP
    wagering/       # Entrada HTTP de apostas
  infrastructure/
    persistence/    # Conexão, schemas, repositories e migrations
    workers/        # Recuperação, publicação e consumo
    observability/  # Logs JSON e métricas Prometheus
    health/         # Verificação de dependências
    messaging/      # Consumo de transações, validação e publicação no SQS
tests/
  integration/      # PostgreSQL real, HTTP e concorrência
  support/          # Banco isolado e protocolo dos processos de teste
  unit/
    application/
    domain/
      entities/
      value-objects/
```

O domínio concentra as regras e não importa NestJS ou infraestrutura. A aplicação usa um contrato de persistência; o módulo NestJS conecta esse contrato ao repository PostgreSQL. HTTP e SQS compartilham validação de entrada e o mesmo caso de uso financeiro.

## Etapas implementadas

1. Domínio financeiro e testes unitários — base implementada.
2. PostgreSQL, MikroORM, migrations e abertura de wallet — implementados.
3. BET, WIN e LOSS por HTTP, idempotência e concorrência — implementados.
4. REFUND, ROLLBACK e recuperação de referências — implementados.
5. Consultas e reconciliação — implementadas.
6. Eventos, outbox e publisher SQS — implementados.
7. Consumidor SQS, inbox, retry e DLQ — implementados.
8. Health checks, observabilidade, testes de falhas distribuídas e documentação final — implementados.

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

A regra de uma reversão por tipo permite um REFUND e um ROLLBACK da mesma BET; essa interpretação está documentada em ARCHITECTURE.md. Transições geram os eventos correspondentes na outbox, inclusive a rejeição por expiração. O consumidor de entrada aceita essas mesmas operações; a correlação é mantida até os eventos e a recuperação de referências.

## Consultas e reconciliação

```sh
curl http://localhost:3000/wagering/transactions/TRANSACTION_ID
curl http://localhost:3000/providers/provider-a/wagering/transactions/bet-1
curl 'http://localhost:3000/wallets/WALLET_ID/ledger?limit=50'
curl -X POST http://localhost:3000/wallets/WALLET_ID/reconciliation
curl -H 'Authorization: Bearer SEU_TOKEN_OPERADOR' http://localhost:3000/metrics
```

As consultas retornam 200; recursos inexistentes retornam 404; identificadores ou parâmetros inválidos retornam 400. A consulta de transação inclui `result`, com o snapshot persistido do processamento, ou null para OPENING. Não expõe hash ou idempotency key.

O ledger retorna `{ "items": [...], "nextCursor": "..." }`. O limite padrão é 50 e aceita de 1 a 100 entradas. Siga `nextCursor` no parâmetro `cursor` da mesma wallet até receber null. A ordem segue a sequência de inserção do ledger. As páginas mantêm o limite capturado na primeira consulta: novas movimentações aparecem ao iniciar outra paginação. O cursor é opaco, vinculado à wallet e não deve ser interpretado ou montado pelo cliente.

A reconciliação retorna saldo armazenado, soma calculada do ledger, `difference = storedBalance - calculatedBalance`, `consistent` e `checkedEntries`. Não altera dados. Uma divergência retorna 200 com `consistent: false`, gera log JSON sem valores financeiros e incrementa `wallet_reconciliation_mismatches_total`, exposto em `/metrics`. Aceita `X-Correlation-Id` opcional (até 128 letras, dígitos, pontos, underscores, dois-pontos ou hífens); quando ausente, gera um UUID.

A métrica conta verificações com divergência por processo, sem labels por wallet, e reinicia com o processo. As demais métricas estão descritas abaixo.

## Eventos e outbox

A operação financeira e seus eventos são confirmados juntos no PostgreSQL. O publisher lê apenas registros confirmados e envia para `wager-events.fifo`, criada pelo hook de inicialização do LocalStack. A entrada usa `wager-transactions.fifo`, com `wager-transactions-dlq.fifo` como DLQ. O hook cria as três filas e configura redrive com cinco recebimentos.

Eventos: WagerTransactionProcessed (inclusive LOSS e OPENING), WagerTransactionRejected, WagerTransactionPendingReference, WalletBalanceChanged e WagerTransactionFailed (falha permanente de uma operação já aceita). O envelope inclui eventId, aggregateId, correlationId, causationId, occurredAt, version e data. Valores monetários continuam sendo strings.

O publisher roda a cada segundo, em lotes de até 10 mensagens, sem bloquear wallets. Falhas de envio mantêm a mensagem pendente, com backoff de 1 segundo até 5 minutos e sem descarte por limite de tentativas. `OUTBOX_PUBLISHER_ENABLED=false` desativa o agendamento, preservando os eventos para publicação posterior.

`SQS_ENDPOINT`, `SQS_EVENTS_QUEUE_URL` e as credenciais de exemplo são configurações locais do LocalStack. O exemplo usa porta 4566 e região us-east-1. Não precisa de conta AWS. Antes de iniciar a versão nova, atualize o `.env` conforme `.env.example` e aplique `bun run migration:up`.

Submissão de aposta e abertura de wallet aceitam `X-Correlation-Id` opcional. Ele é persistido para manter a correlação quando uma referência é reprocessada. O replay não gera outro conjunto de eventos.

A publicação é at-least-once: uma falha entre aceitação pelo SQS e confirmação de publishedAt permite reenvio com o mesmo eventId. Consumidores precisam deduplicar esse identificador de forma persistente; FIFO não substitui essa garantia. A migration não cria eventos retroativos para transações de etapas anteriores.

## Entrada SQS

`SQS_CONSUMER_ENABLED=false` desabilita o consumo. As URLs ficam em `SQS_TRANSACTIONS_QUEUE_URL` e `SQS_TRANSACTIONS_DLQ_URL`. Após atualizar o código, aplique `bun run migration:up`. Para criar as filas em um LocalStack que já estava em execução, rode:

```sh
docker compose exec localstack sh /etc/localstack/init/ready.d/ready.sh
```

Envie para a fila de entrada este envelope, substituindo playerId e walletId pelos IDs de uma wallet existente. No SDK/CLI SQS, informe também MessageGroupId (walletId é uma boa escolha) e MessageDeduplicationId. A inbox usa o messageId do corpo, não o ID atribuído pelo broker.

```json
{
  "messageId": "msg-bet-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-23T12:00:00.000Z",
  "correlationId": "round-001",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "bet-001",
    "idempotencyKey": "provider-a:bet-001",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-001",
    "gameId": "game-001",
    "kind": "BET",
    "money": { "amount": "10.00", "currency": "BRL" }
  }
}
```

Processadas, rejeitadas por negócio e PENDING_REFERENCE recebem ack após commit. Falhas transitórias tentam novamente após 1, 2, 4 e 8 segundos; no quinto recebimento vão para a DLQ. Payload inválido ou conflito permanente vai diretamente para a DLQ. O corpo original é preservado com atributos failureCode, receiveCount, consumerName e sourceMessageId. Corrija a causa antes de reenviar: a identidade de uma operação confirmada não pode ser reutilizada com dados diferentes.

O consumidor faz long polling de dois segundos, uma mensagem por vez por instância, com visibilidade padrão de 60 segundos (`SQS_VISIBILITY_TIMEOUT_SECONDS`, inteiro entre 1 e 43200). Instâncias adicionais trabalham em paralelo. Em SIGTERM, interrompe o receive e aguarda o processamento e ack da mensagem em andamento antes de fechar os clientes.

## Health checks e observabilidade

```sh
curl -i http://localhost:3000/health/live
curl -i http://localhost:3000/health/ready
curl -H 'Authorization: Bearer SEU_TOKEN_OPERADOR' http://localhost:3000/metrics
```

Liveness retorna 200 enquanto a aplicação atende. Readiness consulta PostgreSQL e as três filas configuradas, retornando 200 ou 503 com checks up/down, sem expor URLs ou credenciais. O prazo das verificações é 2,5 segundos. Health checks são públicos e independem dos flags de agendamento dos workers. /metrics exige token de operador quando AUTH_ENABLED=true. Readiness verifica as dependências financeiras PostgreSQL/SQS; indisponibilidade do JWKS é reportada como 503 na autenticação quando não há chave utilizável em cache.

Os logs de execução usam JSON, timestamp, nível, correlação e identificadores disponíveis. Payloads, saldos, keys de idempotência e parâmetros SQL não são registrados. Quando X-Correlation-Id não é informado, a entrada HTTP gera um identificador reutilizado pelo processamento financeiro.

| Métrica                                | Significado                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| wager_transactions_total{status,kind}  | Transições financeiras confirmadas, incluindo OPENING; replay e tentativa ainda pendente não repetem a transição |
| wager_duplicates_total                 | Replays bem-sucedidos em HTTP ou SQS                                                                             |
| processing_retries_total{component}    | Retentativas de entrada SQS, outbox e recuperação de referências                                                 |
| sqs_dead_lettered_total                | Envios à DLQ confirmados pelo consumidor                                                                         |
| database_lock_conflicts_total{code}    | Timeout de lock, deadlock e falha de serialização                                                                |
| wager_processing_duration_seconds      | Histograma de duração da unidade financeira, incluindo falhas e replays                                          |
| outbox_pending_messages                | Eventos confirmados ainda não publicados                                                                         |
| outbox_lag_seconds                     | Idade do evento pendente mais antigo; zero quando não há pendências                                              |
| wallet_reconciliation_mismatches_total | Verificações de reconciliação com divergência                                                                    |

Counters e histograma pertencem ao processo e reiniciam com ele; não substituem auditoria persistente. As gauges da outbox são consultadas no PostgreSQL a cada scrape e representam o mesmo backlog compartilhado entre instâncias: não devem ser somadas. As labels usam categorias limitadas; IDs ficam somente nos logs. Redrive feito diretamente pelo SQS não incrementa o contador da aplicação e deve ser acompanhado também pelos atributos da fila/DLQ. Um scrape sem acesso ao banco retorna 503.

Para repetir o smoke test do JavaScript compilado com banco e filas temporários:

```sh
bun run build
bun tests/support/compiled-app-smoke.ts
```

Esse teste usa as mesmas configurações TEST_DATABASE_URL e TEST_SQS_ENDPOINT da integração e a porta HTTP 3107 livre. Verifica HTTP, replay, consumo SQS, publicação dos cinco eventos esperados, saldo reconciliado, métricas, logs JSON e encerramento SIGTERM. Os workers reais ficam habilitados nesse processo.

## Escopo e limitações

- Nesta branch, autenticação externa está implementada com Keycloak/JWKS. O realm e seus segredos são exclusivos de desenvolvimento; as configurações de produção exigem IdP persistente, HTTPS e gestão de segredos.
- Não foram implementados os diferenciais opcionais: teste de carga, OpenTelemetry, dashboard e ledger de partidas dobradas.
- A DLQ exige análise e reenvio operacional. A visibilidade de entrada não possui heartbeat; inbox e locks protegem contra efeito financeiro duplicado quando houver redelivery.
- FAILED é persistido quando uma operação já aceita como PENDING_REFERENCE sofre uma falha permanente de integridade na recuperação. Erros anteriores à aceitação atômica não criam uma transação financeira artificial e ficam auditados na DLQ.
- O Compose executa PostgreSQL e LocalStack; a aplicação roda pelo Bun no host. Filas locais são efêmeras, enquanto o PostgreSQL de desenvolvimento usa volume persistente. Após recriar o LocalStack, o publisher retoma eventos ainda pendentes no banco; eventos já marcados como publicados não são republicados automaticamente.

## Falhas permanentes de operações aceitas

Na recuperação de referências, erros determinísticos de persistência (SQLSTATE 23502, 23503, 23514, 22001 e 22003) causam rollback da tentativa financeira. Em outra transação, o worker bloqueia a wallet, relê a operação e, se ela ainda estiver PENDING_REFERENCE, confirma FAILED com `failureCode: PERSISTENCE_INTEGRITY_FAILURE`, snapshot do resultado, fim da agenda de recuperação e evento WagerTransactionFailed na outbox. Essa segunda transação não altera saldo nem cria lançamento.

Se outro worker já concluiu a operação, seu resultado é preservado. Se o registro da falha ou seu evento não puderem ser confirmados, a operação continua pendente para recuperação posterior. Deadlocks, timeouts, falhas de conexão e erros desconhecidos continuam transitórios; esgotamento do TTL da referência continua sendo REJECTED / REFERENCE_NOT_FOUND.

Uma submissão HTTP que repete uma operação FAILED retorna HTTP 500 com o snapshot original, failureCode e idempotentReplay: true. Reenviar a mesma key não tenta movimentar saldo novamente. Uma redelivery SQS já aceita retorna o mesmo resultado e recebe ack, pois a falha terminal já está auditada. Investigue e corrija a causa antes de definir operacionalmente uma nova tentativa de negócio.

Os testes `permanent-failures.test.ts`, `inbox.test.ts` e `sqs-reversal-restart.test.ts` comprovam a diferença entre erro pré-aceitação e falha de operação aceita, atomicidade do registro FAILED/evento, concorrência, replay e recuperação de REFUND/ROLLBACK por SQS após SIGKILL. O roteiro para apresentação está em [PRESENTATION.md](PRESENTATION.md).

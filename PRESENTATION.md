# Roteiro de apresentação — Distributed Wagering Processor

Duração sugerida: 10 a 15 minutos. Use os comandos do README para subir PostgreSQL/LocalStack, aplicar migrations e iniciar a aplicação. Não rode testes que injetam falhas contra o banco de desenvolvimento: os helpers usam bancos e filas exclusivos de teste.

## 1. Problema e garantias — 2 minutos

Explique as condições assumidas: entrega duplicada, eventos fora de ordem, várias instâncias e morte do processo em qualquer ponto. As garantias são saldo não negativo, efeito financeiro único, ledger auditável e preservação dos eventos confirmados.

Mostre Money (decimal string + decimal.js), Wallet e as factories das entidades. Explique o uso de numeric(18,2), constraints e triggers no PostgreSQL. A garantia de idempotência fica no banco; FIFO reduz trabalho duplicado.

## 2. Uma operação financeira — 3 minutos

Crie uma wallet com 100.00 BRL seguindo o exemplo do README e submeta uma BET de 25.00. Mostre o saldo 75.00, a entrada DEBIT e o resultado persistido. Reenvie a mesma idempotency key e payload: o resultado terá idempotentReplay true, sem outro débito. Altere o valor mantendo a key para demonstrar conflito.

Abra SubmitWager e PostgresWageringUnitOfWork: transação SQL, lock da linha da wallet antes do cálculo, wallet/ledger/resultado/outbox confirmados juntos. Explique por que wallets diferentes podem avançar em paralelo.

## 3. Concorrência comprovada — 2 minutos

Com a infraestrutura de testes ativa, execute:

```sh
bun test tests/integration/wagering.test.ts
```

Destaque os testes: duas apostas de 80.00 disputando 100.00, 50 cópias da mesma aposta, três processos independentes e outra wallet avançando enquanto uma está bloqueada. O resultado obrigatório é um débito de 80.00, uma rejeição e saldo final 20.00.

## 4. Falhas e recuperação — 4 minutos

```sh
bun test tests/integration/sqs-reversal-restart.test.ts
bun test tests/integration/permanent-failures.test.ts
bun test tests/integration/inbox.test.ts
bun test tests/integration/outbox.test.ts
```

Apresente as fronteiras de falha:

- REFUND/ROLLBACK chega antes da BET: aceitação PENDING_REFERENCE, agenda persistente e recuperação por outro processo após SIGKILL.
- Morte após commit e antes do ack: inbox e idempotência permitem redelivery com um efeito financeiro.
- Commit financeiro antes da publicação: a outbox continua disponível para outro publisher.
- Erro transitório: retry com backoff; erro permanente anterior à aceitação: DLQ.
- Erro permanente na recuperação de uma operação aceita: rollback da tentativa e confirmação de FAILED + evento, sem movimento financeiro. Uma falha nessa auditoria mantém a operação pendente.

Explique a escolha de FOR UPDATE SKIP LOCKED na outbox e seu custo: uma transação SQL permanece aberta durante o envio SQS com timeout. Não prometa exactly-once no broker; a publicação é at-least-once.

## 5. Diagnóstico e fechamento — 2 minutos

Mostre /health/live, /health/ready, /metrics e o endpoint de reconciliação. Explique correlationId, contadores locais por processo, gauges da outbox compartilhada e ausência de valores financeiros nos logs.

Se houver tempo, demonstre a aplicação compilada com todos os workers:

```sh
bun run build
bun tests/support/compiled-app-smoke.ts
```

Feche com as decisões de escopo: autenticação externa omitida conforme permitido, guard preparado para IdP, sem teste de carga ou dashboard opcional. Mencione as limitações documentadas: soma do ledger nos triggers, ausência de heartbeat de visibilidade e operação manual da DLQ. Discuta evoluções com base em medição de contenção e volume.

## Perguntas para preparar

- Por que lock pessimista por wallet, e o que ocorre no timeout?
- Como key, hash do payload, messageId e eventId têm responsabilidades diferentes?
- Como o replay preserva o saldo original depois de outras movimentações?
- Como impedir que REFUND ou ROLLBACK reverta a referência duas vezes pelo mesmo tipo?
- Como diferenciar REJECTED, FAILED e DLQ?
- O que acontece quando o banco confirma e o processo morre antes de registrar uma métrica ou fazer ack?
- Como observar cada instância sem somar várias vezes o mesmo backlog da outbox?
- Quais garantias continuam válidas se o FIFO entregar duplicatas?

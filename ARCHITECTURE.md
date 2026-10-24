# Arquitetura e decisões técnicas

O serviço recebe operações por HTTP ou SQS e mantém saldo, ledger, resultado idempotente e eventos consistentes no PostgreSQL. As garantias financeiras ficam no banco. A fila FIFO ajuda com ordenação e deduplicação, mas o processamento também precisa ser seguro diante de duplicatas e concorrência entre instâncias.

## Organização

| Camada           | Responsabilidade                                                    |
| ---------------- | ------------------------------------------------------------------- |
| `domain`         | Money, Wallet, transações, ledger, inbox, outbox e eventos          |
| `application`    | Casos de uso e portas de persistência, publicação e observação      |
| `contracts`      | Validação de negócio compartilhada entre HTTP e SQS                 |
| `http`           | Controllers, autenticação/autorização de entrada e respostas        |
| `infrastructure` | PostgreSQL/MikroORM, SQS, Keycloak, workers, logs e métricas        |
| `tests`          | Testes unitários, integração e suporte para processos independentes |

O domínio não importa NestJS ou ORM. Entidades usam construtores privados, factories e transições explícitas. `rehydrate` reconstrói o estado persistido sem repetir regras de transição. Os schemas e mapeadores ficam na infraestrutura.

Bun executa aplicação e testes. TypeScript usa modo estrito, propriedades opcionais exatas e checagem de acesso por índice. O build com `tsc` preserva os metadados de decorators usados pelo NestJS e inclui somente `src`.

## Valores monetários e regras de domínio

Money usa uma configuração isolada de `decimal.js`, com precisão de 40 dígitos. A persistência usa `numeric(18,2)` e `DecimalType` em modo string. Nenhum valor financeiro é convertido para `number`.

Entradas exigem strings não negativas com duas casas decimais, sem sinais, espaços, notação científica ou zeros adicionais à esquerda. Valores com mais casas são rejeitados, não arredondados. O limite é `9999999999999999.99`. BRL, USD e EUR estão habilitadas; operações entre moedas diferentes falham. A aritmética permite resultados negativos para calcular divergências, mas saldos e contratos de entrada não os aceitam.

Wallet começa na versão 1. Saldo inicial positivo gera OPENING e crédito no ledger; abertura com zero não gera transação. A versão só aumenta quando o saldo muda. Cada movimento cria um lançamento validado antes de alterar o agregado.

LOSS usa zero e não gera ledger. As demais operações exigem valor positivo. REFUND referencia BET; ROLLBACK referencia BET, WIN ou REFUND. A referência deve coincidir em provedor, jogador, wallet, moeda e rodada, e a reversão deve ser integral. WIN e LOSS podem referenciar BET; BET não aceita referência.

A unicidade de reversão é por referência **e tipo**, conforme o enunciado: uma BET pode receber um REFUND e um ROLLBACK distintos. Não há cancelamento global da rodada. Reversão que causaria saldo negativo é rejeitada com `REVERSAL_INSUFFICIENT_FUNDS`, distinto de `INSUFFICIENT_FUNDS` de BET.

## Persistência e concorrência

Escolhi MikroORM pelo controle explícito da unidade de trabalho e dos locks. Cada operação usa `fork()` para obter um EntityManager isolado e `transactional()` para delimitar commit e rollback. Os flushes intermediários enviam alterações ao banco, mas só o commit confirma o conjunto.

Escolhi lock pessimista por wallet para serializar operações que disputam o mesmo saldo. A escrita obtém `PESSIMISTIC_WRITE` antes de ler e calcular o saldo, em READ COMMITTED. Instâncias distintas disputam a mesma linha; wallets diferentes podem avançar em paralelo. A espera por lock é limitada a 5 segundos e cada statement a 15 segundos. Timeout aborta a unidade financeira, permitindo reenvio com a mesma key.

O fluxo de escrita confirma em uma única transação:

1. Inbox e seu lock, quando a origem é SQS.
2. Lock da wallet e rechecagem da identidade da operação.
3. Aplicação das regras de negócio.
4. Transação, resultado, wallet e ledger correspondente.
5. Eventos na outbox e marcação da inbox como processada.

Uma falha reverte o conjunto. A ordem inbox → wallet é fixa; HTTP e recuperação adquirem somente o lock da wallet. Não existe lock global nem cache em memória como garantia financeira.

O schema aplica:

- Unicidade de jogador/moeda, idempotency key e provedor/identificador externo.
- No máximo um lançamento por wallet/transação e uma reversão processada por referência/tipo.
- Checks monetários, aritmética do lançamento e identidade das operações processadas.
- Imutabilidade do ledger contra UPDATE, DELETE e TRUNCATE, e proteção de transações terminais.
- Triggers adiados que exigem ledger para movimentos processados e comparam saldo com sua soma no commit.

Os triggers são `DEFERRABLE INITIALLY DEFERRED` para aceitar estados intermediários dos flushes. Rejeições podem preservar a identidade incompatível recebida para auditoria, mas não produzem ledger. O custo da proteção saldo/ledger é somar lançamentos da wallet nas verificações; esse custo cresce com seu histórico e exige medição antes de uso em grande volume.

As migrations são explícitas e reversíveis, sem sincronização automática de schema. `down` pode remover dados e funcionalidade. Na reversão da migration 2, a antiga FK composta volta como NOT VALID para preservar rejeições auditáveis existentes. A migration 5 preenche somente metadados de correlação de registros antigos, sob lock transacional; não cria eventos retroativos.

## Idempotência

No HTTP, a fonte da key é o header `Idempotency-Key`; no SQS, é `data.idempotencyKey`. A key é global e aceita de 1 a 255 caracteres ASCII imprimíveis sem espaços. O identificador externo não a substitui.

`hashWagerPayload` calcula SHA-256 de JSON UTF-8 com campos de negócio ordenados explicitamente, inclusive dentro de `money`. A referência entra apenas quando fornecida. Key e metadados de transporte não entram nesse hash. Não há normalização de valores: os contratos já exigem formato monetário fixo.

Antes de obter o lock, a entrada HTTP consulta se a operação já existe e pode retornar seu resultado. Para operações novas, a consulta é repetida sob lock. As constraints impedem que wallets diferentes aceitem simultaneamente a mesma identidade de transação. Mesma key com outro payload é conflito; mesmo identificador externo com outra key também é conflito.

O resultado é um snapshot JSONB persistido junto à operação. Replay preserva saldo, status e failureCode originais e muda apenas `idempotentReplay`. Uma rejeição não se torna processada após novos créditos. Operações pendentes atualizam o snapshot ao mudar de estado; resultados terminais são imutáveis.

## Estados e recuperação de referências

| Estado            | Significado                                                         |
| ----------------- | ------------------------------------------------------------------- |
| PENDING           | Estado inicial durante o processamento                              |
| PENDING_REFERENCE | Aceita, aguardando a referência                                     |
| PROCESSED         | Aplicada; terminal                                                  |
| REJECTED          | Rejeitada por negócio; terminal                                     |
| FAILED            | Falha permanente de infraestrutura de uma operação aceita; terminal |

Referência ausente ou ainda não terminal mantém PENDING_REFERENCE. Referência terminal rejeitada ou falha causa `REFERENCE_NOT_PROCESSED`. Identidade incompatível é rejeitada assim que conhecida.

A cada execução, a recuperação consulta até 50 candidatas. O worker é agendado a cada segundo. Após bloquear a wallet, relê estado e prazo antes de agir. Isso torna seleções duplicadas seguras entre instâncias. Uma falha não impede as demais candidatas do lote.

A agenda é persistente: atraso inicial de 1 segundo, backoff exponencial até 5 minutos e TTL de 24 horas. O prazo permite atraso operacional sem espera indefinida. Na expiração, uma referência já disponível ainda pode resolver a operação; se continuar ausente, há rejeição com `REFERENCE_NOT_FOUND`. Tentativas ainda pendentes não repetem o evento de pendência.

### Falha permanente após aceitação

Uma submissão nova confirma tudo ou nada; erro antes dessa aceitação não cria um FAILED artificial. No SQS, essa entrega pode seguir para DLQ. A recuperação de PENDING_REFERENCE possui uma aceitação anterior e pode registrar FAILED.

Após rollback, o adapter traduz SQLSTATE 23502, 23503, 23514, 22001 e 22003 para `PermanentPersistenceError`. São violações de integridade ou representação que repetir os mesmos dados no mesmo schema não resolve. Unicidade mantém a política de conflito. Deadlock, serialização, timeout, conexão e erros desconhecidos não recebem essa classificação.

O worker abre outra transação, bloqueia a wallet e relê a operação. Se ela ainda estiver PENDING_REFERENCE, confirma FAILED, snapshot com `PERSISTENCE_INTEGRITY_FAILURE`, encerramento da agenda e `WagerTransactionFailed` na outbox, sem alterar saldo ou ledger. A wallet é reconstruída após o rollback, evitando usar saldo alterado somente em memória. Uma resolução concorrente terminal prevalece.

Se essa auditoria também falhar, ela é revertida e a operação continua pendente. HTTP retorna 500 com o snapshot persistido no replay de FAILED; GET continua retornando o recurso. Uma redelivery SQS aceita recebe ack após replay transacional, pois a falha terminal já está auditada.

## Códigos de falha

Rejeições retornam um `failureCode` estável no resultado persistido. Reenviar a mesma key não reavalia uma operação terminal; o provedor deve corrigir a causa e decidir explicitamente sobre uma nova operação.

| Código                                  | Causa                                            |
| --------------------------------------- | ------------------------------------------------ |
| `INSUFFICIENT_FUNDS`                    | BET sem saldo                                    |
| `REVERSAL_INSUFFICIENT_FUNDS`           | Reversão que exigiria saldo negativo             |
| `PLAYER_MISMATCH` / `CURRENCY_MISMATCH` | Operação incompatível com a wallet               |
| `BALANCE_LIMIT_EXCEEDED`                | Crédito ultrapassa o limite monetário            |
| `REFERENCE_MISMATCH`                    | Referência com identidade ou rodada incompatível |
| `INVALID_REFERENCE_KIND`                | Tipo de referência não permitido                 |
| `REVERSAL_AMOUNT_MISMATCH`              | Valor diferente do total da referência           |
| `REFERENCE_ALREADY_REVERSED`            | Referência já revertida pelo mesmo tipo          |
| `REFERENCE_NOT_PROCESSED`               | Referência terminal rejeitada ou falha           |
| `REFERENCE_NOT_FOUND`                   | Referência ausente após o TTL                    |
| `PERSISTENCE_INTEGRITY_FAILURE`         | FAILED após erro permanente na recuperação       |

Conflitos de entrada usam `IDEMPOTENCY_CONFLICT`, `EXTERNAL_TRANSACTION_CONFLICT` ou `TRANSACTION_IDENTITY_CONFLICT`. Na inbox, conteúdo divergente para o mesmo messageId usa `INBOX_MESSAGE_CONFLICT`. Esses conflitos não alteram operações previamente confirmadas.

## Inbox, outbox e SQS

HTTP e SQS compartilham `SubmitWager`, `applyWager` e validação de negócio. O consumidor rejeita campos desconhecidos, valores monetários numéricos, OPENING e o provedor reservado `__internal__`.

A inbox usa a chave `(consumerName, messageId)`, com messageId do envelope de aplicação. Seu hash combina tipo, idempotency key e hash do negócio; occurredAt e correlationId ficam fora. Reusar uma identidade com outro conteúdo é conflito permanente. O caminho SQS registra a inbox mesmo para uma operação previamente aceita por HTTP. Redelivery não cria novo efeito financeiro ou evento.

O ack usa o receipt handle atual e ocorre após commit. Operações processadas, rejeitadas por negócio ou aceitas como pendentes recebem ack. Erros transitórios usam visibilidade de 1, 2, 4 e 8 segundos; no quinto recebimento há encaminhamento à DLQ. Erros permanentes seguem diretamente para ela.

O encaminhamento confirma primeiro o envio do corpo original e atributos de diagnóstico à DLQ e depois remove a origem. Se envio ou ack falhar, a entrega continua recuperável. O redrive nativo da fila também limita a cinco recebimentos. Duplicatas na DLQ são possíveis fora da janela FIFO; análise e reenvio são operacionais.

A outbox contém eventos confirmados na mesma unidade financeira: Processed, Rejected, PendingReference, BalanceChanged e Failed. LOSS gera somente Processed; abertura positiva gera Processed e BalanceChanged. Dados monetários são MoneyProps e datas são ISO no envelope versionado. A correlação original acompanha a recuperação; no SQS, causationId identifica a mensagem.

Cada publisher seleciona uma mensagem com `FOR UPDATE SKIP LOCKED`. Mantém apenas o lock da outbox durante o envio, sem bloquear a wallet. Essa escolha dispensa um mecanismo de reserva com prazo de expiração, mas mantém uma conexão e uma transação SQL abertas durante a chamada ao SQS. Cada execução tenta publicar até 10 mensagens; o worker é agendado a cada segundo.

Após envio, o publisher confirma `publishedAt`. Erro persiste backoff de 1 segundo até 5 minutos; eventos confirmados não expiram. Uma falha entre aceitação no SQS e commit de publishedAt pode reenviar o mesmo eventId: a publicação é **at-least-once**. Consumidores de saída precisam deduplicar eventId persistentemente. aggregateId é MessageGroupId; eventId é MessageDeduplicationId. Publishers concorrentes podem intercalar eventos da mesma wallet; walletVersion permite identificar a evolução de saldo.

O consumidor recebe uma mensagem por chamada, com long polling de 2 segundos e visibilidade padrão de 60 segundos. `SQS_VISIBILITY_TIMEOUT_SECONDS` ajusta esse prazo. Não há heartbeat: operações lentas podem gerar redelivery e contenção, embora inbox/locks impeçam efeito financeiro duplicado. Os indicadores em memória dos workers só evitam sobreposição local de timers.

Em SIGTERM, os workers param novos recebimentos/agendamentos e aguardam o trabalho recebido antes de fechar clientes e banco. O AbortController cancela o receive, não o SQL em andamento. SIGKILL é recuperado por visibilidade, inbox, agenda de referências e outbox.

## Consultas e reconciliação

Repositories de leitura retornam projeções, sem entidades gerenciadas ou EntityManager. Não há banco separado, cache ou infraestrutura adicional de CQRS. A consulta por provedor usa conjuntamente providerId e externalTransactionId; hashes e keys permanecem internos.

O ledger usa sequência bigint gerada no banco, lida como string. Cursor base64url versionado contém wallet, última posição e limite superior capturado na primeira página. A leitura usa REPEATABLE READ e paginação por chave, sem offset. Novos lançamentos não entram no meio de uma paginação existente. Lacunas após rollback são válidas. O cursor é opaco para o cliente, não é assinado e não concede autorização.

A reconciliação calcula saldo armazenado e soma do ledger no mesmo snapshot SQL, sem lock de escrita. A diferença é armazenado menos calculado, em strings decimais. OPENING participa da soma; wallet vazia calcula zero. Divergências não são corrigidas automaticamente: geram resposta, log e métrica. O custo é percorrer o histórico da wallet.

## Autenticação e autorização

Keycloak emite access tokens por client_credentials. `AccessTokenVerifier` é a porta; o adapter usa `jose` com RS256, issuer/audience configurados, sub/iat/exp obrigatórios e validação temporal. O claim typ=Bearer distingue access token de ID token. A URL JWKS vem da configuração do servidor, nunca do token.

As chaves ficam em cache por até 10 minutos, com cooldown de 5 segundos para resolução de novas chaves e timeout de fetch de 2 segundos. Tokens verificáveis com chaves em cache não exigem consulta a cada requisição. Revogação da service account não invalida imediatamente tokens emitidos; a duração local é de 5 minutos.

O papel operator administra wallets, métricas e todas as transações. O papel provider exige `provider_id` atribuído pelo IdP e só acessa operações desse provedor. Wallets são compartilhadas no domínio e não têm proprietário providerId; suas rotas são administrativas. A consulta por ID verifica propriedade no guard e relê no controller, ao custo de uma consulta adicional; a identidade é imutável.

Health é público. SQS é um canal interno confiável e não usa Bearer token, mas mantém validação de identidade no domínio. AUTH_ENABLED é true por padrão; false é explícito para execução local e testes financeiros. 401 indica credencial inválida/ausente, 403 indica falta de permissão e 503 indica indisponibilidade de chaves utilizáveis do IdP.

O realm local usa service accounts, sem password grant, cadastro de usuários na aplicação ou emissão própria de tokens. Keycloak usa start-dev, HTTP local e H2 efêmero. TLS, persistência do IdP e gestão de segredos próprios são necessários fora desse ambiente. O [guia de autenticação](AUTHENTICATION.md) descreve o uso local.

## Observabilidade

A instrumentação observa transações financeiras após commit. Replay e tentativa que continua pendente não repetem uma transição. Counters e histograma são locais ao processo e sujeitos à janela entre commit e observação; a auditoria fica no banco e na DLQ.

| Métrica                                          | Medição                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `wager_transactions_total{status,kind}`          | Transições confirmadas, incluindo OPENING e FAILED               |
| `wager_duplicates_total`                         | Replays detectados                                               |
| `processing_retries_total{component}`            | Retentativas SQS, outbox e referências                           |
| `sqs_dead_lettered_total`                        | Envios à DLQ confirmados pelo consumidor                         |
| `database_lock_conflicts_total{code}`            | Timeout de lock, deadlock e serialização                         |
| `wager_processing_duration_seconds`              | Unidade financeira, abertura positiva, falhas sob lock e replays |
| `outbox_pending_messages` / `outbox_lag_seconds` | Backlog e idade do evento pendente mais antigo                   |
| `wallet_reconciliation_mismatches_total`         | Verificações com divergência                                     |

O histograma não mede o percurso completo no broker nem validações rejeitadas antes do caso de uso. Redrive nativo do SQS não incrementa o contador da aplicação; observe também a fila/DLQ. Reenvios podem ser contados novamente.

As gauges da outbox são lidas do PostgreSQL a cada scrape, com timeout SQL de 2 segundos, e incluem eventos em backoff. Repetem o mesmo backlog em cada instância e não devem ser somadas. Sem acesso ao banco, `/metrics` retorna 503.

Liveness indica atendimento. Readiness consulta PostgreSQL e as três filas, em paralelo, com prazo de 2,5 segundos por dependência. O prazo HTTP não cancela uma aquisição SQL pendente; a consulta usa statement timeout de 2 segundos após obter conexão. A inicialização exige banco. Readiness verifica as dependências financeiras; falhas JWKS são reportadas pela autenticação.

Logs JSON carregam timestamp, nível, correlationId e IDs disponíveis, sem corpos, tokens, segredos ou parâmetros SQL. IDs ficam nos logs, não em labels de métricas.

## Evidências e limites

Os testes usam PostgreSQL e LocalStack reais, com bancos e filas exclusivos. Exercitam migrations up/down, constraints, rollback, replay, disputa de saldo, 50 duplicatas, três processos, publishers concorrentes, DLQ, SIGTERM e SIGKILL. Reversões recebidas antes da BET são recuperadas por outro processo; a consistência final é conferida pelo ledger. A autenticação também é testada com Keycloak real e a aplicação compilada.

Os principais custos são o lock em wallets disputadas, a soma do ledger nos triggers/reconciliação, a conexão SQL ocupada durante publicação e a ausência de heartbeat. Não há evidência de throughput de produção nem garantia de disponibilidade durante falhas prolongadas. Teste de carga, OpenTelemetry, dashboard e partidas dobradas ficam fora desta versão.

LocalStack é efêmero: perda de mensagens já publicadas exige tratamento operacional, pois publishedAt não é revertido pela perda da fila. As migrations não geram eventos históricos retroativos. Essas escolhas delimitam o ambiente local do desafio.

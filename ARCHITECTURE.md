# Decisões de arquitetura

## Escopo atual

Estão implementados o domínio financeiro, a persistência PostgreSQL e a abertura e consulta de wallet por HTTP. Abertura confirma wallet, OPENING e ledger na mesma transação. Os testes unitários e de integração usam Bun e PostgreSQL real. BET, WIN, LOSS, REFUND e ROLLBACK estão disponíveis por HTTP, com idempotência persistente e lock por wallet. Referências fora de ordem são recuperadas por um worker agendado. Consultas de transações, ledger paginado e reconciliação estão implementados. Os quatro eventos mínimos, a outbox transacional e a publicação em SQS estão implementados. Consumidor de entrada, inbox persistente, retry/DLQ e shutdown estão implementados. Health checks e a instrumentação restante estão pendentes.

## Organização

Uma aplicação NestJS modular, com possibilidade de executar várias instâncias. A separação será introduzida conforme cada responsabilidade aparecer: entrada HTTP, casos de uso, domínio, persistência e mensageria. Não haverá camadas que apenas repassem dados.

TypeScript usa modo estrito, checagem de acesso por índice e propriedades opcionais exatas. O domínio não dependerá de decorators do NestJS ou do ORM.

O domínio está dividido em `entities`, `value-objects` e `errors`. Wallet é a raiz do agregado e fica junto às demais entidades, sem uma pasta adicional apenas para ela. Os testes ficam fora do código de produção, em `tests/unit`, espelhando as pastas do domínio. Novas categorias de testes serão adicionadas quando houver integração e concorrência real para verificar.

Lint e checagem de tipos abrangem código de produção e testes. O build inclui apenas `src`, mantendo `dist/main.js` como entrada. Imports são explícitos, sem arquivos de reexportação ou aliases neste estágio. Helpers de teste usam nomes que descrevem o que criam; ficam no arquivo que os utiliza enquanto não houver necessidade real de compartilhamento. Blocos condicionais exigem chaves pelo ESLint.

## Runtime e build

Bun 1.x será usado para instalar dependências, executar a aplicação e rodar testes. O build usa `tsc`, preservando os metadados de decorators necessários ao NestJS. ESLint verifica também regras que dependem de tipos; Prettier cuida da formatação.

## Persistência e concorrência

MikroORM 6 foi escolhido por ser preferencial no enunciado e permitir explicitar a unidade transacional. Mapeamentos `EntitySchema` separados mantêm as classes do domínio livres de decorators e necessidades do ORM. Money usa `decimal.js`; os schemas usam `DecimalType` em modo string e `numeric(18,2)` no PostgreSQL, sem conversão monetária para `number`.

O processamento usa `LockMode.PESSIMISTIC_WRITE` na linha da wallet, antes de ler e calcular o saldo, dentro de uma transação READ COMMITTED. Isso serializa operações da mesma wallet e permite paralelismo entre wallets distintas. O custo é a espera por lock em wallets muito disputadas. O limite de espera é 5 segundos, com timeout de statement de 15 segundos. Timeouts abortam a transação e retornam 503; o cliente pode reenviar a mesma key. Não há retry interno ilimitado.

Cada chamada do repository cria um EntityManager com `fork()`, isolando Unit of Work e Identity Map. `transactional()` delimita o commit. A abertura persiste a wallet, a transação OPENING e o ledger com flushes explícitos para respeitar as foreign keys; flush não é commit. Falha em qualquer inserção reverte o conjunto. Saldo zero não gera OPENING. A outbox participa dessa mesma fronteira transacional. A inbox será acrescentada quando o consumidor de entrada for implementado.

As migrations são a fonte da verdade do schema: não usamos atualização automática nem geração de schema em runtime. Elas são registradas explicitamente e executadas pelo Migrator, conforme a [documentação do MikroORM](https://mikro-orm.io/docs/migrations). A migration inicial possui `up` e `down`, testados em banco exclusivo e temporário. AJV 8 é uma dependência explícita para satisfazer o peer de `ajv-draft-04` na cadeia de dependências do ORM; sem ela, o AJV 6 do ESLint era resolvido incorretamente na execução com Bun.

O banco aplica unicidade por jogador/moeda, por key de idempotência global e por provedor/identificador externo. O ledger possui unicidade por wallet/transação, foreign keys que vinculam moeda e wallet, checks de aritmética e saldos não negativos e triggers que bloqueiam UPDATE, DELETE e TRUNCATE. O índice parcial de reversões permite no máximo uma reversão processada por referência e tipo.

Um constraint trigger `DEFERRABLE INITIALLY DEFERRED` compara saldo e soma do ledger ao final da transação, obtendo lock apenas da wallet correspondente. É necessário adiar a checagem para permitir os estados intermediários entre os flushes. O custo é somar o ledger a cada checagem disparada; foi escolhido como proteção explícita nesta etapa e deverá ser avaliado com volumes maiores. A aplicação de apostas obtém o lock antes de ler/calcular o saldo. O trigger não substitui essa estratégia.

A segunda migration vincula status e tipo ao ledger por triggers adiados: operações financeiras processadas exigem lançamento de mesmo valor e direção; LOSS e transações não processadas não podem ter lançamento. Identidade de jogador/moeda é validada para operações processadas, permitindo que rejeições preservem os valores enviados para auditoria. Estados terminais têm proteção contra alterações SQL. A terceira migration valida também a identidade, tipo, estado e valor integral das referências processadas e persiste a agenda de retentativas.

Os testes verificam 50 cópias da mesma aposta, duas apostas de 80 disputando 100 e processamento independente de outra wallet enquanto uma está bloqueada. Um cenário adicional usa três processos Bun independentes, com barreira de prontidão, para submeter 50 cópias e verificar débito único. A suíte SQS também usa três processos consumidores e mata um processo após commit antes do ack, comprovando redelivery com efeito único.

O rollback da segunda migration remove o snapshot do resultado. Para preservar rejeições auditáveis que não combinam com a identidade da wallet, a FK composta anterior é restaurada como NOT VALID: ela volta a validar novas escritas, sem excluir registros existentes. Não é uma operação de rollback de aplicação sem perda de funcionalidade; migrations down são ferramentas de desenvolvimento e precisam ser avaliadas antes de uso em um banco com dados.

## Autenticação

A integração com Identity Provider fica fora da implementação inicial, pois não pontua no desafio. O `ProviderIdentityGuard` é o ponto de extensão explícito e atualmente permite todas as requisições de wallets e apostas. Uma evolução poderá validar tokens OIDC de um IdP externo, associar a identidade autenticada ao providerId e proteger as rotas de negócio. Health checks permanecerão públicos. Não haverá armazenamento próprio de senhas.

## Decisões ainda pendentes

- Completar health checks, métricas e revisão de logs.

Essas decisões serão resolvidas antes das respectivas implementações e acompanhadas de testes.

## Domínio financeiro

Money aceita entradas não negativas com exatamente duas casas decimais, sem espaços, sinal, notação científica ou zeros à esquerda adicionais. Valores com mais casas são rejeitados, nunca arredondados. O limite absoluto é `9999999999999999.99`, compatível com `numeric(18,2)`. Resultados fora desse intervalo também são rejeitados. Uma configuração isolada de Decimal com precisão de 40 dígitos permite somar e subtrair esses valores sem perda de centavos.

As moedas habilitadas são BRL, USD e EUR, todas com duas casas para este desafio. Isso mantém o modelo multi-moeda sem assumir suporte a todas as moedas ISO-4217. Comparações e operações entre moedas diferentes lançam `CURRENCY_MISMATCH`. Aritmética e reidratação permitem negativos, necessários para diferenças de reconciliação; contratos de entrada usam `Money.from`, que os rejeita.

BET, WIN, REFUND, ROLLBACK e OPENING exigem valor positivo. LOSS usa zero e não produz ledger. Wallet permite abertura com zero, inicia na versão 1 e incrementa a versão em cada movimentação positiva. Seus métodos retornam o lançamento correspondente, validado antes de modificar o saldo. O caso de uso de abertura persiste OPENING e seu crédito para saldo inicial positivo, mantendo a versão inicial em 1.

As factories `rehydrate` recompõem estado persistido sem executar transições. Ledger não expõe mutações; datas são retornadas como cópias para evitar alteração indireta. A imutabilidade do ledger também é aplicada por triggers no banco.

Transações nascem PENDING e podem passar para PENDING_REFERENCE quando têm referência explícita. Ambos os estados podem terminar em PROCESSED, REJECTED ou FAILED. PENDING_REFERENCE pode permanecer nesse estado durante tentativas de resolução. Estados terminais recusam qualquer transição posterior.

REFUND aceita BET; ROLLBACK aceita BET, WIN ou REFUND e inverte sua direção. Reversões exigem valor integral. WIN e LOSS podem carregar referência a BET, sujeita às mesmas validações de identidade e estado; sem referência, não dependem de uma BET. BET não aceita referência. A decisão de aguardar ou rejeitar uma referência é responsabilidade do caso de uso, enquanto o domínio valida a referência resolvida.

## Idempotência e processamento

`SubmitWager` coordena submissão e idempotência; `applyWager` compartilha a aplicação das regras entre submissão e recuperação; `WageringUnitOfWork` expõe apenas as operações que precisam compartilhar a mesma transação SQL e a wallet bloqueada. O adapter PostgreSQL implementa essa fronteira com EntityManager próprio. Mapeadores explícitos fazem a conversão entre registros e factories de domínio e são compartilhados com a abertura de wallet.

A idempotency key vem exclusivamente do header e é global, com 1 a 255 caracteres ASCII imprimíveis sem espaços. Nunca é derivada nem substituída pelo identificador externo. `hashWagerPayload` usa SHA-256 sobre JSON UTF-8 com as chaves de negócio em ordem lexicográfica explícita, inclusive em `money`. A referência só entra quando fornecida. Headers, key, messageId e demais metadados de transporte são excluídos. Os valores não são normalizados: contratos exigem strings decimais em escala fixa.

Uma leitura prévia pode devolver um replay já confirmado sem disputar o lock. Para uma nova submissão, a consulta é repetida após obter o lock, pois a primeira leitura não garante exclusividade. A unicidade no banco resolve disputas entre wallets diferentes. O mesmo identificador externo com outra key é conflito, mesmo quando o payload coincide.

O resultado é persistido em JSONB na mesma transação do débito/crédito e ledger. O replay devolve esse snapshot, inclusive saldo, status e failureCode, alterando apenas idempotentReplay. Uma rejeição por saldo insuficiente continua rejeitada mesmo após novos créditos. Enquanto uma operação está pendente, seu snapshot é atualizado atomicamente quando o worker muda seu estado; após atingir estado terminal, o snapshot não muda mais. Valores de saldo são strings também no JSONB.

## Respostas e falhas atuais

| Situação                                                     | HTTP / código                       |
| ------------------------------------------------------------ | ----------------------------------- |
| BET, WIN ou LOSS processada; replay de processamento         | 200                                 |
| Referência ausente ou ainda pendente                         | 202 / PENDING_REFERENCE             |
| Payload ou key inválida, operação fora do escopo atual       | 400                                 |
| Wallet inexistente                                           | 404 / WALLET_NOT_FOUND              |
| Mesma key com outro payload                                  | 409 / IDEMPOTENCY_CONFLICT          |
| Identificador externo já usado com outra key                 | 409 / EXTERNAL_TRANSACTION_CONFLICT |
| Corrida de identidade detectada pela constraint              | 409 / TRANSACTION_IDENTITY_CONFLICT |
| Rejeição persistida por regra de negócio; replay de rejeição | 422                                 |
| Timeout de lock ou indisponibilidade transitória do banco    | 503 / DATABASE_UNAVAILABLE          |
| Falha inesperada de persistência                             | 500 / INTERNAL_ERROR                |

Rejeições atuais incluem INSUFFICIENT_FUNDS, PLAYER_MISMATCH, CURRENCY_MISMATCH, BALANCE_LIMIT_EXCEEDED, REFERENCE_MISMATCH, REFERENCE_NOT_PROCESSED e INVALID_REFERENCE_KIND. Nenhuma altera saldo ou cria ledger. Erros do driver são convertidos sem expor SQL ou parâmetros. Reversões acrescentam REFERENCE_ALREADY_REVERSED, REVERSAL_AMOUNT_MISMATCH e REVERSAL_INSUFFICIENT_FUNDS. A expiração de uma referência ainda indisponível usa REFERENCE_NOT_FOUND.

## Reversões e recuperação de referências

REFUND credita uma BET processada. ROLLBACK inverte BET, WIN ou REFUND; quando implica débito, saldo insuficiente gera REVERSAL_INSUFFICIENT_FUNDS e não produz ledger. Reversões parciais são rejeitadas. O lock por wallet protege a consulta de reversões anteriores; o índice único parcial é a garantia adicional no banco.

A interpretação adotada segue literalmente a unicidade por referência **e tipo** do enunciado. Assim, REFUND e ROLLBACK podem cada um reverter a mesma BET uma vez, produzindo dois créditos distintos. Não há uma regra adicional de cancelamento global da rodada. Essa escolha está explícita porque um produto real poderia optar por outra semântica; o teste confirma o comportamento definido aqui.

Referência ausente ou ainda não terminal mantém a operação PENDING_REFERENCE. Referência terminal rejeitada ou falha causa REFERENCE_NOT_PROCESSED. Identidade incompatível é rejeitada assim que conhecida, mesmo se a referência ainda estiver pendente.

A agenda é persistida com contador de tentativas, próximo horário e expiração. O atraso inicial é 1 segundo, dobra a cada tentativa e tem teto de 5 minutos. A expiração é 24 horas após criação, permitindo atrasos operacionais sem manter operações pendentes indefinidamente. O próximo horário nunca ultrapassa a expiração. Na checagem de expiração, uma referência já disponível ainda pode resolver a operação; se continuar indisponível, a operação é rejeitada com REFERENCE_NOT_FOUND.

Cada instância consulta até 50 candidatas por execução. A seleção não bloqueia transações; depois de obter o lock da wallet, o worker relê estado e prazo. Isso evita inverter a ordem de locks entre submissão e recuperação e torna seleções duplicadas seguras. Apenas uma tentativa por operação vence a rechecagem de horário. Uma falha não impede o processamento das demais candidatas; a falha é reportada após o lote e sua transação permanece disponível para retry.

`ReferenceRecoveryWorker` executa um lote a cada segundo, sem sobreposição local. O indicador em memória serve apenas ao agendamento: PostgreSQL mantém a correção entre instâncias. `REFERENCE_RECOVERY_ENABLED=false` desativa o agendamento, útil para testes determinísticos. Antes do encerramento, o worker interrompe o timer e aguarda o lote em andamento, antes do fechamento da conexão com PostgreSQL.

Os testes incluem referências anteriores à BET, dois recuperadores concorrentes, persistência do backoff, expiração sem sleeps longos, falha e rollback durante recuperação e execução real do timer. A recuperação após reconexão não substitui os futuros testes de morte forçada de processos.

Transições de recuperação também persistem seus eventos na outbox, inclusive rejeição por expiração. Uma tentativa que continua pendente atualiza apenas a agenda, sem repetir o evento de pendência.

## Consultas e paginação do ledger

As leituras possuem repositories próprios, que retornam projeções sem expor EntityManager ou entidades gerenciadas. Os casos de uso de escrita continuam usando suas fronteiras transacionais; a separação evita que consultas dependam de operações de persistência de agregados. Não há infraestrutura adicional de CQRS, cache ou banco separado.

A consulta por provedor usa conjuntamente providerId e externalTransactionId. A projeção inclui status, referência, failureCode e o snapshot do resultado original; alterações posteriores no saldo não afetam esse snapshot. Hash e idempotency key ficam internos.

A migration 4 acrescenta `sequence_number`, bigint gerado pelo PostgreSQL, ao ledger. Ela fornece uma ordenação única por wallet sem depender de precisão de timestamps ou ordem aleatória de UUIDs. O campo técnico não altera a entidade de domínio e é lido como string, preservando valores além de Number.MAX_SAFE_INTEGER. A identidade pode ter lacunas após rollback; continuidade numérica não é um requisito.

A primeira página captura a maior sequência visível. Cursor versionado em base64url carrega a wallet, a última posição e esse limite superior. As páginas seguintes usam keyset pagination, nunca offset. Cada leitura roda em REPEATABLE READ e somente leitura; a primeira captura e a seleção de entradas compartilham um snapshot. Escritas da aplicação são serializadas por wallet, de modo que a sequência acompanha sua ordem de inserção/commit. Novas movimentações ficam acima do limite e aparecem em uma nova paginação.

O cursor é validado quanto a versão, escopo, formato e limites de bigint. Ele não é uma credencial nem um mecanismo de autorização; não contém segredos e não é assinado. Consumidores devem tratá-lo como opaco. Uma reversão de migration que recrie as sequências invalida cursors anteriores.

## Reconciliação e métrica de divergências

O repository faz uma única consulta agregada, usando o mesmo snapshot MVCC para saldo armazenado e ledger. Isso evita comparar um saldo anterior a um commit com lançamentos posteriores. A aritmética usa numeric do PostgreSQL e devolve strings decimais em escala 2; nenhum valor financeiro passa por number. A projeção não precisa construir um Money limitado ao saldo máximo para representar uma possível divergência em dados corrompidos.

A diferença é armazenado menos calculado. Saldo inicial positivo entra na soma via OPENING. Wallet vazia calcula 0.00 e zero entradas. A consulta não adquire lock de escrita nem altera ou corrige registros. O custo é percorrer as entradas da wallet, aceitável para a reconciliação explícita do desafio.

Uma diferença gera resposta `consistent: false`, log JSON com walletId e correlationId sem valores financeiros e incremento de wallet_reconciliation_mismatches_total. O cliente [@prometheus-io/client](https://github.com/prometheus/client_js) fornece Counter e Registry; usamos um registry por aplicação para evitar estado global compartilhado nos testes. A métrica é exposta em GET /metrics, sem labels por wallet para limitar cardinalidade. O contador é local ao processo e conta cada verificação divergente; um coletor poderá acompanhar cada instância. As outras métricas obrigatórias ainda não foram implementadas.

O teste de divergência desabilita temporariamente o trigger de proteção apenas em um banco criado exclusivamente pelo teste, injeta inconsistência e comprova resposta, log, métrica e ausência de correção automática. Os demais testes mantêm as proteções habilitadas. Também há testes de paginação durante novas movimentações, isolamento de consultas por provedor e reconciliação durante débitos concorrentes.

## Eventos e transactional outbox

O domínio define IntegrationEvent e uma subclasse concreta por evento mínimo. Factories validam o estado correspondente; o payload contém MoneyProps e datas ISO no envelope. As cópias e o congelamento dos dados evitam mutação indireta. OutboxMessage encapsula estado de publicação, contador de falhas e backoff; reidratação não repete transições.

Os casos de uso constroem os eventos, e os adapters persistem OutboxMessage com o mesmo EntityManager da operação financeira. Abertura positiva gera Processed e BalanceChanged; abertura zero não gera transação nem eventos. LOSS gera somente Processed. Rejeições geram somente Rejected. Uma referência inicialmente ausente gera PendingReference; novas tentativas pendentes não repetem esse evento. Uma resolução posterior ou expiração gera seu novo evento terminal. Replays não persistem eventos adicionais.

O correlationId fornecido por HTTP é validado e persistido com a transação; quando ausente, um UUID é gerado. A recuperação reutiliza esse contexto. O causationId usa o identificador da transação por padrão e permite um identificador de transporte no futuro consumidor SQS. O contexto de transporte não participa do payloadHash.

A migration 5 cria a outbox com envelope JSONB, eventId como chave primária e índice parcial para registros pendentes. Constraints validam a identidade do envelope e valores básicos de publicação. Triggers impedem mudança do envelope e alteração de mensagens já publicadas. Ela também adiciona metadados de correlação aos registros existentes: a proteção terminal é suspensa apenas dentro da migration transacional, sob o lock de alteração do schema, para preencher correlationId com o ID da transação sem modificar campos financeiros. Não há backfill de eventos históricos; as garantias de eventos se aplicam às novas transições a partir dessa migration. O down remove os eventos e metadados dessa etapa.

O publisher obtém uma mensagem pendente com FOR UPDATE SKIP LOCKED e mantém apenas esse lock durante o envio. Mensagens e wallets são tabelas distintas, e o publisher não adquire lock da wallet. Há no máximo um envio em andamento por mensagem entre publishers concorrentes. A escolha evita leases e tokens de posse; o custo é manter uma transação SQL aberta durante uma chamada de rede. Cada envio possui timeout configurado, e cada transação trata somente uma mensagem. A execução processa até 10 mensagens e não se sobrepõe localmente.

Após envio bem-sucedido, publishedAt é confirmado no banco. Erro de envio incrementa attempts e persiste nextAttemptAt com atraso exponencial de 1 segundo até 5 minutos. Não há expiração ou descarte de eventos confirmados. Erro de banco desfaz a tentativa e deixa o registro disponível. Uma falha após o envio, antes do commit, pode gerar reenvio com o mesmo eventId. Portanto, a entrega continua at-least-once e exige deduplicação persistente do consumidor.

SqsEventPublisher usa o SDK oficial, aggregateId como MessageGroupId e eventId como MessageDeduplicationId em wager-events.fifo. A [documentação do SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessage.html) descreve a janela limitada de deduplicação: ela é uma otimização, não a garantia final. Publishers concorrentes podem intercalar eventos da mesma wallet; consumidores devem usar eventId e walletVersion conforme sua responsabilidade, sem assumir ordenação global.

O Compose fixa LocalStack 4.0.3 e usa um hook ready.d para a fila de saída. O serviço de testes separado usa porta 4567 e filas exclusivas por teste. A aplicação está configurada para o ambiente local do desafio; não há provisionamento AWS externo. O SDK não faz retry interno, deixando a política de publicação concentrada na outbox.

O worker interrompe o timer e aguarda a operação em andamento antes de fechar banco e cliente SQS. Testes com PostgreSQL e SQS reais comprovam atomicidade com falha injetada na outbox, invisibilidade de registros não confirmados, dois publishers concorrentes, falha de envio, retomada por nova conexão e reenvio após rollback posterior à aceitação pelo SQS. Esse rollback simula a fronteira de publicação. A entrada também possui teste de morte forçada de um consumidor após commit antes do ack.

## Inbox e consumo de entrada

HTTP e SQS resolvem SubmitWager pelo WagerProcessingModule. O módulo do consumidor não depende de controllers HTTP. O DTO de negócio fica em contracts e é compartilhado; a validação da fila adiciona envelope e idempotencyKey, rejeitando campos desconhecidos, valores monetários numéricos, OPENING e o provedor reservado. O canal interno dispensa autenticação externa, mas mantém a validação da identidade do provedor.

A migration 006 cria inbox_messages com chave composta (consumer_name, message_id). O messageId pertence ao envelope de aplicação, e consumerName é versionado (wager-transactions-v1). O hash SHA-256 combina tipo, idempotencyKey e o hash canônico dos campos de negócio. Metadados occurredAt/correlationId ficam fora desse hash. Reutilizar a identidade com dados ou chave diferentes é conflito permanente, inclusive após o processamento.

A transação insere a inbox com ON CONFLICT DO NOTHING, obtém seu lock e valida o hash antes de bloquear a wallet. Essa ordem é fixa em todos os consumidores. Após executar o mesmo caso de uso HTTP, marca a inbox como processada antes do commit conjunto de transação, wallet, ledger e outbox. Um erro reverte todos esses registros. O caminho SQS evita o replay antecipado fora da transação: mesmo uma operação previamente aceita por HTTP precisa registrar sua entrega. Redelivery de uma inbox processada percorre o replay sob lock, sem novo ledger ou evento. O trigger SQL protege a identidade e o estado processado contra alterações.

Uma PENDING_REFERENCE já aceita recebe inbox processada e ack; a recuperação posterior usa a agenda financeira persistente. Rejeições de negócio também são confirmadas e recebem ack. Erros de domínio lançados antes da aceitação, envelopes inválidos e violações SQL de integridade são permanentes e seguem para DLQ. Conexão indisponível, deadlock, serialização e falhas desconhecidas usam retry. O contador persistente de recebimentos do SQS limita a cinco tentativas. O backoff de visibilidade é 1, 2, 4 e 8 segundos; a política suporta teto de 30 segundos se ampliada. Não há contador em memória como garantia.

O ack usa o receipt handle da entrega e ocorre após o retorno do commit. A visibilidade é alterada por mensagem para retry; veja [ChangeMessageVisibility](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html). Para DLQ, primeiro confirma o envio do corpo original e atributos de diagnóstico, depois remove a origem. Falha no envio ou no ack deixa a origem recuperável. O deduplicationId do encaminhamento deriva da fila e do ID do broker; a janela FIFO é limitada, portanto ferramentas de operação devem tolerar duplicatas na DLQ. A fila de origem também tem redrive nativo com cinco recebimentos como proteção quando um consumidor não consegue finalizar o encaminhamento.

Uma mensagem inválida ou uma transação cujo commit foi revertido não produz um registro financeiro FAILED artificial. A evidência permanente fica na DLQ; FAILED continua reservado a uma operação financeira aceita que sofra uma transição permanente explícita. Não há descarte silencioso. DLQ requer inspeção e reenvio operacional; não há redrive automático para repetir erros permanentes.

O worker usa long polling de dois segundos, recebe uma mensagem por chamada e não sobrepõe processamento local. Outros processos consomem em paralelo, e a correção permanece no PostgreSQL. A visibilidade padrão de 60 segundos excede os timeouts SQL por comando, mas não é um lease renovado por heartbeat. Se uma operação exceder esse período, pode ocorrer consumo concorrente: inbox e wallet locks preservam efeito único. Isso pode aumentar a contenção e antecipar redrive; heartbeat e ajuste de visibilidade são evolução operacional para workloads lentos.

No shutdown, o AbortController cancela somente ReceiveMessage. SQL, encaminhamento e ack de uma mensagem já recebida continuam até terminar; beforeApplicationShutdown aguarda o loop antes de fechar banco e cliente SQS. SIGKILL é recuperado pela expiração de visibilidade. Os testes usam banco e filas exclusivos, comprovam retry/DLQ, rollback conjunto, identidade divergente, 50 mensagens duplicadas em três processos, SIGKILL no intervalo após commit antes de ack e SIGTERM durante uma operação em andamento. A soma do ledger é verificada contra o saldo nesses cenários.

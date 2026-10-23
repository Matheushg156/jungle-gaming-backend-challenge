# Decisões de arquitetura

## Escopo atual

Estão implementados o domínio financeiro, a persistência PostgreSQL e a abertura e consulta de wallet por HTTP. Abertura confirma wallet, OPENING e ledger na mesma transação. Os testes unitários e de integração usam Bun e PostgreSQL real. BET, WIN, LOSS, REFUND e ROLLBACK estão disponíveis por HTTP, com idempotência persistente e lock por wallet. Referências fora de ordem são recuperadas por um worker agendado. Consultas restantes, reconciliação, inbox, outbox e mensageria ainda estão pendentes.

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

Cada chamada do repository cria um EntityManager com `fork()`, isolando Unit of Work e Identity Map. `transactional()` delimita o commit. A abertura persiste a wallet, a transação OPENING e o ledger com flushes explícitos para respeitar as foreign keys; flush não é commit. Falha em qualquer inserção reverte o conjunto. Saldo zero não gera OPENING. Inbox e outbox serão incluídos na fronteira transacional quando forem implementados.

As migrations são a fonte da verdade do schema: não usamos atualização automática nem geração de schema em runtime. Elas são registradas explicitamente e executadas pelo Migrator, conforme a [documentação do MikroORM](https://mikro-orm.io/docs/migrations). A migration inicial possui `up` e `down`, testados em banco exclusivo e temporário. AJV 8 é uma dependência explícita para satisfazer o peer de `ajv-draft-04` na cadeia de dependências do ORM; sem ela, o AJV 6 do ESLint era resolvido incorretamente na execução com Bun.

O banco aplica unicidade por jogador/moeda, por key de idempotência global e por provedor/identificador externo. O ledger possui unicidade por wallet/transação, foreign keys que vinculam moeda e wallet, checks de aritmética e saldos não negativos e triggers que bloqueiam UPDATE, DELETE e TRUNCATE. O índice parcial de reversões permite no máximo uma reversão processada por referência e tipo.

Um constraint trigger `DEFERRABLE INITIALLY DEFERRED` compara saldo e soma do ledger ao final da transação, obtendo lock apenas da wallet correspondente. É necessário adiar a checagem para permitir os estados intermediários entre os flushes. O custo é somar o ledger a cada checagem disparada; foi escolhido como proteção explícita nesta etapa e deverá ser avaliado com volumes maiores. A aplicação de apostas obtém o lock antes de ler/calcular o saldo. O trigger não substitui essa estratégia.

A segunda migration vincula status e tipo ao ledger por triggers adiados: operações financeiras processadas exigem lançamento de mesmo valor e direção; LOSS e transações não processadas não podem ter lançamento. Identidade de jogador/moeda é validada para operações processadas, permitindo que rejeições preservem os valores enviados para auditoria. Estados terminais têm proteção contra alterações SQL. A terceira migration valida também a identidade, tipo, estado e valor integral das referências processadas e persiste a agenda de retentativas.

Os testes verificam 50 cópias da mesma aposta, duas apostas de 80 disputando 100 e processamento independente de outra wallet enquanto uma está bloqueada. Um cenário adicional usa três processos Bun independentes, com barreira de prontidão, para submeter 50 cópias e verificar débito único. Isso ainda não comprova crash recovery ou concorrência de workers SQS/outbox.

O rollback da segunda migration remove o snapshot do resultado. Para preservar rejeições auditáveis que não combinam com a identidade da wallet, a FK composta anterior é restaurada como NOT VALID: ela volta a validar novas escritas, sem excluir registros existentes. Não é uma operação de rollback de aplicação sem perda de funcionalidade; migrations down são ferramentas de desenvolvimento e precisam ser avaliadas antes de uso em um banco com dados.

## Autenticação

A integração com Identity Provider fica fora da implementação inicial, pois não pontua no desafio. O `ProviderIdentityGuard` é o ponto de extensão explícito e atualmente permite todas as requisições de wallets e apostas. Uma evolução poderá validar tokens OIDC de um IdP externo, associar a identidade autenticada ao providerId e proteger as rotas de negócio. Health checks permanecerão públicos. Não haverá armazenamento próprio de senhas.

## Decisões ainda pendentes

- Extensão da taxonomia de falhas para mensageria; destino dos eventos da outbox.

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

Eventos e outbox ainda não fazem parte do processamento: esta é uma etapa intermediária e não atende à garantia final de não perder eventos após commit. A emissão do evento de rejeição por expiração também depende dessa próxima etapa.

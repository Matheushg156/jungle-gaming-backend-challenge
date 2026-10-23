# Decisões de arquitetura

## Escopo atual

A base executável e as classes do domínio financeiro estão implementadas e possuem testes unitários. Persistência, processamento dos casos de uso e mensageria continuam planejados; ainda não há garantias distribuídas implementadas.

## Organização

Uma aplicação NestJS modular, com possibilidade de executar várias instâncias. A separação será introduzida conforme cada responsabilidade aparecer: entrada HTTP, casos de uso, domínio, persistência e mensageria. Não haverá camadas que apenas repassem dados.

TypeScript usa modo estrito, checagem de acesso por índice e propriedades opcionais exatas. O domínio não dependerá de decorators do NestJS ou do ORM.

O domínio está dividido em `entities`, `value-objects` e `errors`. Wallet é a raiz do agregado e fica junto às demais entidades, sem uma pasta adicional apenas para ela. Os testes ficam fora do código de produção, em `tests/unit`, espelhando as pastas do domínio. Novas categorias de testes serão adicionadas quando houver integração e concorrência real para verificar.

Lint e checagem de tipos abrangem código de produção e testes. O build inclui apenas `src`, mantendo `dist/main.js` como entrada. Imports são explícitos, sem arquivos de reexportação ou aliases neste estágio. Helpers de teste usam nomes que descrevem o que criam; ficam no arquivo que os utiliza enquanto não houver necessidade real de compartilhamento. Blocos condicionais exigem chaves pelo ESLint.

## Runtime e build

Bun 1.x será usado para instalar dependências, executar a aplicação e rodar testes. O build usa `tsc`, preservando os metadados de decorators necessários ao NestJS. ESLint verifica também regras que dependem de tipos; Prettier cuida da formatação.

## Persistência e concorrência planejadas

MikroORM é a escolha proposta por ser preferencial no enunciado e permitir explicitar a unidade transacional. Money usa `decimal.js`; a persistência usará `numeric(18,2)` no PostgreSQL, sem conversão monetária para `number`.

A estratégia proposta é obter lock pessimista na linha da wallet dentro da transação SQL. Isso serializa operações da mesma wallet e permite paralelismo entre wallets distintas. O custo é a espera por lock em wallets muito disputadas. Testes com processos concorrentes deverão comprovar essa estratégia.

Saldo, ledger, transação, inbox e outbox deverão ser confirmados atomicamente. Constraints e mecanismos de imutabilidade no banco serão definidos na etapa de persistência.

## Autenticação

A integração com Identity Provider fica fora da implementação inicial, pois não pontua no desafio. Na etapa HTTP será criada uma porta explícita para identidade do provedor. Uma evolução poderá validar tokens OIDC de um IdP externo, associar a identidade autenticada ao providerId e proteger as rotas de negócio. Health checks permanecerão públicos. Não haverá armazenamento próprio de senhas.

## Decisões ainda pendentes

- Escopo da idempotency key e conflito de identificador externo com outra key.
- Tratamento de referências rejeitadas e recuperação de referências ainda não processadas.
- Combinação de REFUND e ROLLBACK sobre a mesma referência.
- Backoff e expiração de referências pendentes.
- Taxonomia de falhas, status HTTP e destino dos eventos publicados pela outbox.

Essas decisões serão resolvidas antes das respectivas implementações e acompanhadas de testes.

## Domínio financeiro

Money aceita entradas não negativas com exatamente duas casas decimais, sem espaços, sinal, notação científica ou zeros à esquerda adicionais. Valores com mais casas são rejeitados, nunca arredondados. O limite absoluto é `9999999999999999.99`, compatível com `numeric(18,2)`. Resultados fora desse intervalo também são rejeitados. Uma configuração isolada de Decimal com precisão de 40 dígitos permite somar e subtrair esses valores sem perda de centavos.

As moedas habilitadas são BRL, USD e EUR, todas com duas casas para este desafio. Isso mantém o modelo multi-moeda sem assumir suporte a todas as moedas ISO-4217. Comparações e operações entre moedas diferentes lançam `CURRENCY_MISMATCH`. Aritmética e reidratação permitem negativos, necessários para diferenças de reconciliação; contratos de entrada usam `Money.from`, que os rejeita.

BET, WIN, REFUND, ROLLBACK e OPENING exigem valor positivo. LOSS usa zero e não produz ledger. Wallet permite abertura com zero, inicia na versão 1 e incrementa a versão em cada movimentação positiva. Seus métodos retornam o lançamento correspondente, validado antes de modificar o saldo. O caso de uso de abertura deverá persistir OPENING e seu crédito para saldo inicial positivo, mantendo a versão inicial em 1.

As factories `rehydrate` recompõem estado persistido sem executar transições. Ledger não expõe mutações; datas são retornadas como cópias para evitar alteração indireta. A imutabilidade no banco será adicionada nas migrations.

Transações nascem PENDING e podem passar para PENDING_REFERENCE quando têm referência explícita. Ambos os estados podem terminar em PROCESSED, REJECTED ou FAILED. PENDING_REFERENCE pode permanecer nesse estado durante tentativas de resolução. Estados terminais recusam qualquer transição posterior.

REFUND aceita BET; ROLLBACK aceita BET, WIN ou REFUND e inverte sua direção. Reversões exigem valor integral. WIN e LOSS podem carregar referência a BET, sujeita às mesmas validações de identidade e estado; sem referência, não dependem de uma BET. BET não aceita referência. A decisão de aguardar ou rejeitar uma referência é responsabilidade do caso de uso, enquanto o domínio valida a referência resolvida.

`assertReplay` identifica divergência de hash com `IDEMPOTENCY_CONFLICT`. O cálculo canônico do hash e a consulta persistente por key ainda serão implementados. Unicidade das reversões e idempotência entre processos exigirão constraints e transações no PostgreSQL. A rejeição de débito de reversão por saldo insuficiente deverá ser traduzida pelo caso de uso para um código distinto de `INSUFFICIENT_FUNDS`.

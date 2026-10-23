# Decisões de arquitetura

## Escopo atual

Esta etapa entrega apenas a base executável. As escolhas de persistência e mensageria abaixo são planejadas e ainda não representam garantias implementadas.

## Organização

Uma aplicação NestJS modular, com possibilidade de executar várias instâncias. A separação será introduzida conforme cada responsabilidade aparecer: entrada HTTP, casos de uso, domínio, persistência e mensageria. Não haverá camadas que apenas repassem dados.

TypeScript usa modo estrito, checagem de acesso por índice e propriedades opcionais exatas. O domínio não dependerá de decorators do NestJS ou do ORM.

## Runtime e build

Bun 1.x será usado para instalar dependências, executar a aplicação e rodar testes. O build usa `tsc`, preservando os metadados de decorators necessários ao NestJS. ESLint verifica também regras que dependem de tipos; Prettier cuida da formatação.

## Persistência e concorrência planejadas

MikroORM é a escolha proposta por ser preferencial no enunciado e permitir explicitar a unidade transacional. Money usará `decimal.js` e colunas `numeric` no PostgreSQL, sem conversão monetária para `number`.

A estratégia proposta é obter lock pessimista na linha da wallet dentro da transação SQL. Isso serializa operações da mesma wallet e permite paralelismo entre wallets distintas. O custo é a espera por lock em wallets muito disputadas. Testes com processos concorrentes deverão comprovar essa estratégia.

Saldo, ledger, transação, inbox e outbox deverão ser confirmados atomicamente. Constraints e mecanismos de imutabilidade no banco serão definidos na etapa de persistência.

## Autenticação

A integração com Identity Provider fica fora da implementação inicial, pois não pontua no desafio. Na etapa HTTP será criada uma porta explícita para identidade do provedor. Uma evolução poderá validar tokens OIDC de um IdP externo, associar a identidade autenticada ao providerId e proteger as rotas de negócio. Health checks permanecerão públicos. Não haverá armazenamento próprio de senhas.

## Decisões ainda pendentes

- Valores zero permitidos por operação, moedas aceitas e precisão máxima.
- Escopo da idempotency key e conflito de identificador externo com outra key.
- Tratamento de WIN com referência ainda ausente ou rejeitada.
- Combinação de REFUND e ROLLBACK sobre a mesma referência.
- Backoff e expiração de referências pendentes.
- Taxonomia de falhas, status HTTP e destino dos eventos publicados pela outbox.

Essas decisões serão resolvidas antes das respectivas implementações e acompanhadas de testes.

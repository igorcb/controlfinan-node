# ControlFinan (Node.js)

![Node.js](https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![Tailwind](https://img.shields.io/badge/Tailwind-4-06B6D4?logo=tailwindcss&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)

Aplicação web de controle financeiro pessoal, pensada para quem trabalha como motorista de aplicativo. Cada usuário registra entradas (créditos) e saídas (débitos) em contas como dinheiro, bancos e carteiras de aplicativos, e acompanha o saldo por dia e por mês.

Esta é a versão em **Node.js (TypeScript + Fastify)** do [ControlFinan em Rails 8 + Hotwire](https://github.com/igorcb/controlfinan-rails8-hotwire). Ela tem **paridade de funcionalidades e de visual** com o original, assim como as versões em Django, Laravel, Go, Java, Rust e C#: mesmas telas, mesmas regras, mesmas mensagens e **mesmo esquema de banco**. As versões podem usar os mesmos dados, inclusive as senhas.

Usa [Fastify](https://fastify.dev) (com `@fastify/formbody` e `@fastify/static`), o driver [pg](https://node-postgres.com) e o [bcryptjs](https://github.com/dcodeIO/bcrypt.js). O HTML é gerado com template strings do TypeScript e uma função de escape. As consultas com parâmetros viram consultas preparadas com nome (como no pgx do Go e no Postgrex do Elixir), para o Postgres não analisar o mesmo SQL a cada requisição.

## Funcionalidades

| Tela | Rota | O que faz |
|---|---|---|
| Conta Corrente | `/` | Lista os lançamentos, do mais recente para o mais antigo, 30 por página, com o saldo total |
| Saldo do dia | `/current_accounts?date=AAAA-MM-DD` | Filtra a listagem por um dia e mostra o saldo daquele dia |
| Novo lançamento | `/current_accounts/new` | Cadastra um crédito ou um débito |
| Detalhe, edição e exclusão | `/current_accounts/:id` | Mostra, altera ou remove um lançamento |
| Dashboard | `/dashboard` | Abas **Saldo Diário** e **Saldo Mensal** (corridas menos combustível, lavagem e telefone). As setas navegam entre os meses |
| JSON | `/current_accounts.json` e `/current_accounts/:id.json` | Os mesmos dados, para integrações |
| Cadastro, login e senha | `/registration/new`, `/session/new`, `/passwords/new` | Conta de usuário, com senha de no mínimo 6 caracteres |

Cada usuário só enxerga os próprios lançamentos.

## Como a paridade foi feita

| Rails 8 + Hotwire | Node.js |
|---|---|
| Autenticação nativa do Rails 8 (`has_secure_password`, tabela `sessions`, cookie `session_id`) | Mesmo modelo: tabela `sessions` e cookie assinado `session_id`. O hash é gravado no mesmo formato do Rails (`$2a$`), usando só os primeiros 72 bytes da senha |
| Proteção CSRF (`authenticity_token`) | Token em cookie repetido em cada formulário, com o mesmo nome de campo. É conferido antes das rotas |
| `rate_limit to: 10, within: 3.minutes` | Limite de 10 tentativas a cada 3 minutos por IP, em memória |
| Token de redefinição de senha (15 minutos) | Token assinado com validade de 15 minutos, invalidado quando a senha muda |
| `_method` para PATCH, PUT e DELETE | O mesmo campo `_method`. Cada rota POST escolhe a ação pelo método efetivo |
| Strong parameters | Um campo ausente no formulário mantém o valor atual na edição |
| Turbo (`data-turbo-confirm`) e Stimulus (abas) | JavaScript simples para a confirmação e as abas |
| jbuilder | JSON compacto com os mesmos campos e o mesmo formato (por exemplo, `"price":"150.0"`) |
| Tailwind CSS 4 | Tailwind CSS 4 (CLI standalone), com as mesmas classes |

Os valores em dinheiro ficam em centavos inteiros, sem soma em ponto flutuante. O Postgres devolve `price` como texto e `date_ocurrence` como texto (`AAAA-MM-DD`), sem mudança de fuso. O "hoje" usa o fuso `America/Sao_Paulo`.

**Verificação**, com o mesmo usuário e os mesmos dados (7.292 lançamentos) nos dois apps:

- Texto idêntico em todas as telas comparadas, incluindo paginação, filtro por dia, datas e meses inválidos, dashboard, formulários, mensagens de validação (no cadastro e na edição), erros de cadastro e login inválido.
- JSON idêntico byte a byte (lista, terceira página e detalhe).
- Teste de mutação: mudar a paginação para 31, desligar o CSRF ou tirar o filtro por usuário faz os testes falharem.

## Node.js com dois processos

O Node.js roda o JavaScript numa thread só. Em produção o app usa o módulo `node:cluster` e sobe `WEB_CONCURRENCY` processos (padrão 2), que dividem a mesma porta. Assim ele usa as duas CPUs do benchmark, como os outros apps. O processo principal cria as tabelas e depois inicia os workers. Cada worker tem o próprio pool de conexões (`DB_POOL`, padrão 10) e o próprio contador do limite de tentativas.

## Benchmark

O benchmark que compara as versões do ControlFinan, com os mesmos dados e os mesmos limites de CPU e memória, fica no repositório do app de referência: [controlfinan-rails8-hotwire/benchmark](https://github.com/igorcb/controlfinan-rails8-hotwire/tree/main/benchmark).

## Como rodar com Docker

```bash
docker compose up               # app em http://localhost:8008
```

O container de desenvolvimento instala os pacotes, compila o Tailwind e o TypeScript e roda o app com um processo. As tabelas são criadas na subida (mesmo esquema do app Rails). Depois de mudar o código, reinicie com `docker compose restart web`.

Imagem de produção: `Dockerfile.prod` (`docker build -f Dockerfile.prod -t bench-node .`), com o JavaScript compilado, o CSS minificado e só os pacotes de produção, sobre `node:22-slim`. O comando é `node dist/src/main.js`, com `NODE_ENV=production`. Configure `DATABASE_URL`, `SECRET_KEY_BASE` e, se quiser, `BCRYPT_COST` (padrão 12), `DB_POOL` (padrão 10), `WEB_CONCURRENCY` (padrão 2) e `PORT` (padrão 8000).

## Testes

38 testes com o test runner do Node (`node --test`), usando Postgres de verdade e o servidor real numa porta aleatória, cobrindo:

- Formatação de moeda e decimais.
- Senha no formato do Rails, incluindo um hash gravado pelo próprio Rails.
- Validações em pt-BR, saldo e resumo do mês.
- Login, limite de tentativas, logout, CSRF, cadastro e redefinição de senha.
- Lançamentos: filtro, paginação, JSON, criar, editar, excluir e isolamento entre usuários.
- Dashboard.

```bash
docker compose exec web npm test
```

Os testes usam o banco `controlfinan_node_test`, criado automaticamente.

## Estrutura

```
src/main.ts             configuração (variáveis de ambiente), cluster e servidor HTTP
src/server.ts           rotas, handlers, sessão, CSRF, flash e limite de tentativas
src/web.ts              cookies assinados, token CSRF e contador de tentativas
src/models.ts           usuários, lançamentos, validações e consultas
src/format.ts           moeda, decimais e datas como no Rails
src/views/              HTML com o mesmo resultado do app Rails
src/schema.sql          tabelas (mesmo esquema do app Rails)
static/                 JavaScript e ícones (o CSS é gerado pelo Tailwind)
assets/                 fonte do Tailwind
test/                   testes
```

## Licença

[MIT](LICENSE)

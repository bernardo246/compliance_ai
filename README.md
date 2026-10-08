# Plataforma de Análise de Documentos e Dados com IA

Monorepo simples (duas pastas, dois `package.json`) cobrindo as **Fases 0 a 9**
do plano:

- **Fase 0** — Infraestrutura: NestJS + Next.js, config via `.env`, Helmet,
  CORS, rate limit, health-check, cliente Supabase.
- **Fase 1** — Autenticação: registro/login com bcrypt, JWT de acesso (RS256,
  15min) + refresh token opaco rotativo em cookie `httpOnly` (7 dias), logout,
  detecção de reuso de refresh token.
- **Fase 2** — Autorização e Termo de Uso: RBAC (`user`/`admin`), guard que
  bloqueia qualquer rota de documentos até o usuário aceitar a versão vigente
  do termo, tela de aceite no frontend.
- **Fase 3** — Upload de documentos: validação de MIME real (magic bytes, não
  a extensão), limite de tamanho, upload para o Supabase Storage, expiração em
  72h, listagem/detalhe/exclusão por usuário.
- **Fase 4** — Integração com a IA (piloto `juridico`): extração de texto de
  PDF/CSV/XLSX (`unpdf`, `papaparse`, `exceljs`), template de prompt exaustivo
  (checklist de compliance, anti-alucinação, schema JSON rígido), chamada à
  **OpenRouter** (camada gratuita, ex. modelos Nemotron da NVIDIA) com
  timeout/retry, e validação estrutural da resposta com **Zod** antes de
  qualquer persistência. Testável isoladamente via `npm run golden:test`
  (ver seção 5).
- **Fase 5** — Pipeline assíncrono: o upload enfileira a análise e responde na
  hora; um worker baixa o arquivo do Storage, chama a IA, grava em `analyses`
  e move `documents.status` `uploaded` → `processing` → `done`/`error`.
  Endpoint `GET /api/analyses/:id`. Testável ponta a ponta via
  `npm run pipeline:test` (ver seção 5.1). *Nasceu com uma fila em memória;
  hoje roda sobre **BullMQ + Redis** (ver "Escalabilidade horizontal").*
- **Fase 6** — Frontend de status e resultado: tela `/documentos/[id]` que faz
  polling do status (`uploaded`/`processing` → atualiza sozinha a cada 4s) e,
  quando `done`, renderiza o resultado completo (resumo executivo, checklist
  item a item com veredito/severidade/evidência/sugestão, dados faltantes,
  sugestões de melhoria, aviso legal). A lista em `/upload` também faz polling
  e cada item vira link para o resultado.
- **Fase 7** — Retenção de 72h: job agendado (hoje um job repetível do
  BullMQ, a cada hora; nasceu como `@Cron`) varre `documents` com `expira_em` vencido, remove **só o arquivo original**
  do Storage e marca `storage_path = null` + `deletado_em` — o resultado em
  `analyses` nunca é tocado. Exclusão antecipada pelo próprio usuário já existe
  desde a Fase 3 (`DELETE /api/documents/:id`). Testável via
  `npm run retention:test` (ver seção 5.2).
- **Fase 8** — Hardening de segurança: rate limit dedicado em login/registro
  (5/min) e upload (10/min); logs de auditoria com IP real cobrindo login,
  login falho (inclusive e-mail desconhecido), logout, reuso de refresh token,
  upload e exclusão; Helmet com CSP/HSTS explícitos; verificação de malware no
  upload (heurística de PDF sempre ativa + ClamAV plugável, desligado por
  padrão); checklist de segurança da spec revisado item a item. Testável via
  `npm run malware-scan:test` e `npm run security:test` (ver seção 5.3).
- **Fase 9** — Expansão de templates: as 5 áreas que faltavam (`financas`,
  `imobiliario`, `rh`, `saude`, `outro`) ganharam template próprio, com o
  mesmo rigor da Fase 4 (checklist exaustivo, compliance regulatório
  específico do domínio, anti-alucinação, cobertura de fraude/irregularidade
  do nicho). `saude` restrito deliberadamente a completude administrativa,
  nunca avaliação clínica. Golden set próprio por área (12 fixtures no total),
  testável via `npm run golden:test` (ver seção 5).

- **Escalabilidade horizontal** (trabalho separado, em 8 etapas — ver a seção
  "Escalabilidade horizontal — Redis, BullMQ e Nginx"): estado compartilhado
  em Redis (rate limit, fila, agendamento), imagem Docker do backend,
  Docker Compose com várias réplicas e Nginx na frente, com testes de race
  condition, queda de réplica e dois dispositivos na mesma conta.

O visual do frontend segue à risca o `design-system.md` (paleta escura +
verde, glassmorphism, grid de fundo, glow, tipografia).

**Versões:** Node.js 22+ (testado com Node 24), NestJS 11.x, Next.js 16.x +
React 19. Todas as dependências foram checadas contra `npm audit` — zero
vulnerabilidades conhecidas na árvore de dependências no momento da entrega.

## Estrutura

```
projeto-analise-ia/
├── backend/
│   ├── src/
│   │   ├── auth/          # Fase 1-2 (Fase 8: rate limit dedicado + logs de auditoria)
│   │   ├── common/redis/  # Escalabilidade — cliente Redis compartilhado + cache
│   │   ├── common/debug/  # Escalabilidade — endpoint de diagnóstico (instância + contador + IP)
│   │   ├── monitoring/    # Alertas de monitoramento (regras + webhook) e batimentos das rotinas
│   │   ├── documents/     # Fase 3 (upload) + retention.service/processor (Fase 7, BullMQ)
│   │   │   └── security/  # Fase 8 — malware-scan.service.ts, pdf-heuristics.ts, clamav.client.ts
│   │   └── analysis/      # Fase 4-5 — extração, analysis-queue.service + analysis.processor (BullMQ), schema; prompts/ tem as 6 áreas (Fase 4 + 9)
│   ├── Dockerfile         # Escalabilidade — imagem multi-stage, usuário não-root, sem segredos
│   ├── scripts/           # golden set (F4/F9) + pipeline (F5) + retenção (F7) + malware/segurança (F8)
│   │                      # + testes de escalabilidade: queue-race, double-stall, e2e-http, load-balancer
│   ├── test-fixtures/     # 12 PDFs de teste (2 por área) com problemas conhecidos injetados
│   └── sql/               # 001_init + 002_analysis_pipeline + 003_retention + 004_scale_indexes.sql (rodar no Supabase, em ordem)
├── nginx/nginx.conf        # Escalabilidade — load balancer na frente das réplicas (local, HTTP)
├── nginx/nginx.prod.conf   # Produção — Nginx como borda da VM: HTTPS + balanceamento
├── certs/                  # Certificado TLS do Nginx de produção (fullchain.pem, privkey.pem — ignorados pelo git)
├── docs/arquitetura-producao.svg  # Diagrama da arquitetura de produção (embutido abaixo)
├── docker-compose.yml      # Escalabilidade — Redis + N réplicas do backend + Nginx (porta 8080)
├── docker-compose.test.yml # Override só p/ testes: expõe o Redis em localhost:6379
├── docker-compose.prod.yml # Produção (o que roda na VM): Nginx com HTTPS + N réplicas do backend; Redis gerenciado fora
└── frontend/               # Next.js 16 (App Router)
    └── src/
        ├── app/
        │   ├── upload/         # Fase 3/6 — envio + lista com polling
        │   └── documentos/[id]/ # Fase 6 — status/polling + resultado da análise
        ├── components/         # Navbar, StatusBadge (Fase 6)
        └── lib/                # api.ts, auth-context.tsx, domain.ts (tipos/rótulos compartilhados)
```

## Pré-requisitos

- Node.js 22+ (testado com Node 24)
- Uma conta/projeto no [Supabase](https://supabase.com) (Postgres + Storage)
- Uma conta na [OpenRouter](https://openrouter.ai) (para a Fase 4 — análise via IA, usando a camada gratuita)
- Docker (Docker Desktop) — só para o ambiente de várias réplicas com Redis e
  Nginx (seção "Escalabilidade horizontal"); rodar o backend com
  `npm run start:dev` também exige um Redis acessível em `REDIS_URL`
- OpenSSL (para gerar o par de chaves RS256) — já vem instalado no macOS/Linux;
  no Windows, use o Git Bash ou o WSL

## 1. Supabase — passo a passo

### 1.1. Criar o projeto

1. Entre em [supabase.com](https://supabase.com) e crie uma conta (ou faça login).
2. Clique em **New Project**.
3. Escolha uma organização, dê um nome ao projeto (ex: `analise-ia`), defina
   uma senha do banco (guarde-a — não é usada pelo backend, mas é a senha
   raiz do Postgres) e escolha a região mais próxima de você.
4. Aguarde 1-2 minutos até o projeto ficar pronto (status "Active").

### 1.2. Rodar as migrations (criar as tabelas)

1. No painel do projeto, vá em **SQL Editor** (ícone de terminal na sidebar).
2. Clique em **New query**.
3. Abra o arquivo `backend/sql/001_init.sql` deste projeto, copie todo o
   conteúdo e cole no editor.
4. Clique em **Run** (ou `Ctrl+Enter`).
5. Confirme em **Table Editor** que as tabelas apareceram: `users`,
   `refresh_tokens`, `documents`, `analyses`, `audit_logs`.
6. Repita os passos 2-4 com `backend/sql/002_analysis_pipeline.sql` (colunas da
   Fase 5: `analyses.checklist`, `analyses.status_compliance_geral`,
   `documents.processing_started_at`, `documents.erro`, etc.), e depois com
   `backend/sql/003_retention.sql` (índice usado pela varredura da Fase 7) e
   `backend/sql/004_scale_indexes.sql` (índices da limpeza de refresh tokens e dos alertas).
   Rodar **na ordem** (001 → 002 → 003 → 004). Todas são idempotentes
   (`if not exists`), então rodar de novo não quebra nada.

### 1.3. Criar o bucket de Storage

1. Vá em **Storage** na sidebar.
2. Clique em **New bucket**.
3. Nome: `documents` (tem que ser exatamente esse valor, ou você precisa
   ajustar `SUPABASE_STORAGE_BUCKET` no `.env`).
4. Marque o bucket como **Private** (não público) — os documentos dos
   usuários não devem ser acessíveis por URL direta.
5. Clique em **Create bucket**.

### 1.4. Pegar as credenciais da API

1. Vá em **Project Settings** (ícone de engrenagem) → **API**.
2. Você vai precisar de dois valores para o `.env` do backend:
   - **Project URL** → vai em `SUPABASE_URL`
   - **service_role key** (na seção "Project API keys", é a chave secreta,
     não a `anon`/`public`) → vai em `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ A `service_role key` ignora todas as regras de RLS e dá acesso total ao
> banco. Ela só pode existir no `.env` do **backend**, nunca no frontend, nunca
> em código versionado, nunca em log. É exatamente para isso que existe o
> `.gitignore` bloqueando `.env`.

## 2. JWT (RS256) — passo a passo

O access token é assinado com um par de chaves RSA (uma privada, uma
pública), em vez de um segredo simétrico único. Isso significa que só o
backend (que tem a chave privada) consegue *emitir* tokens, mas qualquer
serviço com a chave pública consegue *validar* um token sem conseguir forjar
um novo — útil se no futuro você tiver mais de um serviço validando tokens.

### 2.1. Gerar o par de chaves

Na pasta `backend`, rode:

```bash
openssl genrsa -out jwt-private.pem 2048
openssl rsa -in jwt-private.pem -pubout -out jwt-public.pem
```

Isso cria dois arquivos: `jwt-private.pem` e `jwt-public.pem`. **Não
versione esses arquivos** — o `.gitignore` já os bloqueia (`*.pem`).

### 2.2. Colocar as chaves no `.env`

O `.env` espera as chaves como uma única linha, com as quebras de linha
escapadas como `\n`. O jeito mais fácil de gerar isso corretamente:

```bash
# Linux/macOS:
awk '{printf "%s\\n", $0}' jwt-private.pem
awk '{printf "%s\\n", $0}' jwt-public.pem
```

Copie a saída de cada comando e cole nas variáveis correspondentes:

```bash
JWT_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\n"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIBIj...\n-----END PUBLIC KEY-----\n"
```

O `configuration.ts` do backend já faz o `.replace(/\\n/g, '\n')` de volta
para o formato real do PEM antes de usar.

> Em produção, o ideal é não colocar essas chaves no `.env` em texto puro, e
> sim usar o secrets manager do seu provedor de hospedagem (Vercel, Railway,
> Fly.io, etc. todos têm um). O `.env` é só para desenvolvimento local.

## 3. OpenRouter — passo a passo (Fase 4)

A análise via IA usa a **OpenRouter**, um proxy que dá acesso a vários
modelos (incluindo modelos gratuitos, com rate limit) por uma única API no
formato "chat completions".

1. Crie uma conta em [openrouter.ai](https://openrouter.ai).
2. Gere uma chave de API em [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys)
   — não precisa adicionar crédito se for usar só modelos gratuitos.
3. Cole a chave em `OPENROUTER_API_KEY` no `.env` do backend.
4. **Confirme o slug exato do modelo gratuito** em [openrouter.ai/models](https://openrouter.ai/models)
   (filtre por "free", busque por "nemotron" se quiser um modelo da NVIDIA)
   e cole em `OPENROUTER_MODEL` — o valor que vem por padrão no
   `.env.example` é um palpite informado no momento da entrega deste projeto
   e **pode não existir mais** no catálogo deles quando você for rodar; a
   disponibilidade de modelos gratuitos muda com frequência.
5. Modelos gratuitos costumam ter rate limit mais agressivo e podem ser
   menos consistentes em seguir o formato JSON solicitado do que modelos
   pagos — se o `golden:test` (seção 5) falhar na validação do schema com
   frequência, é sinal de que vale trocar de modelo gratuito ou ajustar o
   prompt para ser ainda mais explícito com aquele modelo específico.

## 4. Backend

```bash
cd backend
npm install
cp .env.example .env
# preencha SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, as chaves JWT (seções 1 e 2)
# e OPENROUTER_API_KEY + OPENROUTER_MODEL (seção 3)

npm run start:dev
# API em http://localhost:3001
```

> **Precisa de um Redis.** O rate limit e a fila de análise usam Redis, então
> o backend não sobe sem um acessível em `REDIS_URL` (o `.env.example` já traz
> `redis://localhost:6379`). O jeito mais simples de ter um, com o Docker aberto:
>
> ```bash
> docker compose up -d redis      # na raiz do repositório; abre a porta 6379 só em 127.0.0.1
> ```
>
> Sem isso o terminal enche de `ECONNREFUSED 127.0.0.1:6379`. Para o ambiente
> completo (várias réplicas + Nginx), veja "Escalabilidade horizontal" e
> "Qual Compose usar".

Teste rápido:

```bash
curl http://localhost:3001/api/health
```

## 5. Testando os templates de análise isoladamente (golden set)

A integração com a IA pode ser testada sem precisar do frontend nem do fluxo
de upload completo — é assim que cada template foi validado durante o
desenvolvimento (Fase 4 para `juridico`, Fase 9 para as outras 5 áreas):

```bash
cd backend

# 1. Gera 12 PDFs de teste em test-fixtures/: um par (com problemas / bem
#    estruturado) para cada uma das 6 áreas de negócio.
npm run golden:build

# 2. Roda a análise de verdade contra os 12 PDFs (usa sua OPENROUTER_API_KEY)
#    e confere, por área, quantos dos problemas conhecidos o modelo capturou.
npm run golden:test

# Ou só uma área específica (mais rápido, evita gastar tokens/tempo à toa):
npm run golden:test -- financas
```

O script imprime, pra cada área, o `resumo_executivo`, o checklist completo
item a item, e ao final uma conferência automática de quantos dos problemas
conhecidos daquela área o modelo realmente encontrou — fechando com um
**resumo geral** de todas as áreas testadas:

```
RESUMO GERAL
✅ juridico: 6/6 problemas conhecidos capturados
⚠️  financas: 4/6 problemas conhecidos capturados
✅ imobiliario: 5/5 problemas conhecidos capturados
...
```

(saída real de uma rodada — `financas` variou entre 4 e 6, dependendo da
formulação exata que o modelo usou naquela chamada; a análise em si continuou
correta e útil, só a correspondência textual do script é que é sensível à
redação. Ver "confira manualmente" abaixo.)

Se algum problema esperado não for capturado consistentemente, é sinal de que
o prompt daquela área (`backend/src/analysis/prompts/<area>.prompt.ts`)
precisa de ajuste — é exatamente para isso que serve o golden set.

### 5.1. Testando o pipeline assíncrono (Fase 5)

Exercita o caminho completo **upload → fila → worker → `analyses` → status
`done`**, sem passar pelo HTTP/login. Requer a migração `002` aplicada e
`npm run golden:build` já rodado.

```bash
cd backend
npm run pipeline:test
```

O script cria um documento de teste, sobe o PDF para o Storage, chama
`AnalysisQueueService.enqueue()` (o mesmo que o upload faz; precisa de um Redis em `REDIS_URL`) e faz polling em
`documents.status`, imprimindo as transições:

```
  [0s]  status: processing
  [48s] status: done
Transições observadas: processing → done
✅ Critério de pronto da Fase 5 atendido (uploaded → processing → done, resultado consultável).
```

Ao final imprime a linha de `analyses` gravada e **limpa tudo que criou**
(documento, análise, objeto no Storage, usuário de teste).

**Como funciona no backend:**

- `DocumentsService.upload()` chama `analysisQueue.enqueue(id)` **sem `await`**
  — a resposta do upload volta na hora com `status: 'uploaded'`.
- `AnalysisQueueService` (`src/analysis/analysis-queue.service.ts`) coloca o job
  numa fila **BullMQ no Redis**, com `jobId = documentId` (um job por documento
  por vez). `AnalysisProcessor` (`src/analysis/analysis.processor.ts`) é o
  worker, com concorrência **fixa em 2 por réplica** (o decorator `@Processor`
  é avaliado antes do `.env` carregar, então não dá para ler de config; a
  variável `ANALYSIS_CONCURRENCY` ficou sem efeito). Cada job: baixa o arquivo
  do Storage → `AnalysisService.analyze()` → `upsert` em `analyses`
  (idempotente, `unique(document_id)`) → `status = 'done'`. Qualquer erro no
  caminho vira `status = 'error'` + `documents.erro` com a mensagem.
- No boot, `recoverPending()` reenfileira documentos que ficaram em `uploaded`
  (enqueue perdido num restart) ou `processing` há mais de
  `ANALYSIS_STUCK_TIMEOUT_MS` (processo caiu no meio de uma análise). O
  `jobId` evita duplicar quando várias réplicas sobem juntas.
- `GET /api/analyses/:id` devolve o resultado (checagem de dono via join com
  `documents.user_id`). `GET /api/documents/:id` passa a incluir `analise`
  (ou `null`) — o frontend consulta status + resultado numa chamada só.

**Decisão de arquitetura — fila in-process vs. BullMQ + Redis**

> **Histórico:** esta decisão foi revertida. A Fase 5 nasceu com a fila
> in-process descrita abaixo; ao fazer a aplicação escalar horizontalmente, o
> gatilho citado no fim desta seção foi atingido e a fila migrou para BullMQ
> (Etapa 4 de "Escalabilidade horizontal"). A comparação continua válida como
> registro do raciocínio.

A spec permite as duas (*"BullMQ/Redis **ou** processamento em background
simples"*). Na época optou-se pela fila in-process. Comparação:

| Aspecto | In-process (implementado) | BullMQ + Redis |
|---|---|---|
| Serviços a rodar | 1 (o backend) | 3 (backend + Redis + worker opcionalmente separado) |
| Sobrevive a restart/crash? | Não — a fila em RAM some. Mitigado pelo `recoverPending()` no boot, que varre o banco e reenfileira `uploaded`/`processing` presos | Sim — o job fica no Redis e é retomado |
| Escala horizontal (2+ instâncias do backend) | Quebra — cada instância teria sua própria fila; dois `recoverPending()` competiriam pelo mesmo documento (o `unique(document_id)` evita linha duplicada, mas desperdiça chamadas à IA) | Funciona — fila compartilhada no Redis, cada job vai para um worker só |
| Worker isolado do servidor HTTP | Não — a análise (dezenas de segundos) roda no mesmo processo que atende requisições | Sim — processo `worker` dedicado, escalável à parte |
| Retry / backoff | Manual (já existe no `openrouter.client.ts`) | Nativo, configurável por job |
| Jobs agendados (ex.: Fase 7 — limpeza de 72h) | Precisa de `@nestjs/schedule`/cron à parte | Embutido (delayed / repeat jobs) |
| Observabilidade da fila | Logs | Dashboard visual (Bull Board) |
| Custo / complexidade | Zero | Redis para manter, monitorar e pagar |

Gatilho para migrar: **precisar de mais de uma instância do backend**, ou
querer isolar o worker do servidor HTTP. Enquanto for uma instância só (deploy
típico de MVP), a fila in-process entrega o mesmo resultado funcional. A
migração é localizada — `enqueue()` vira `queue.add()`, o loop vira
`new Worker()` — sem tocar em `DocumentsService`, controllers ou schema.

### 5.2. Testando a retenção de 72h (Fase 7)

Prova o critério de pronto sem esperar o cron rodar de verdade nem esperar
72h: chama `RetentionService.purgeExpired()` diretamente contra dois
documentos de teste — um com `expira_em` forçado para o passado, outro
(controle) com `expira_em` no futuro.

```bash
cd backend
npm run retention:test
```

```
[EXPIRADO] storage_path=null deletado_em=2026-... → ✅ limpo como esperado
[EXPIRADO] arquivo no Storage → ✅ removido
[EXPIRADO] registro em analyses → ✅ intacto (não foi tocado)

[CONTROLE] storage_path=.../controle.pdf deletado_em=null → ✅ não foi tocado (correto)

✅ Critério de pronto da Fase 7 atendido.
```

**Como funciona no backend:**

- `RetentionService.purgeExpired()` (`src/documents/retention.service.ts`),
  disparado a cada hora por um **job repetível do BullMQ**: no boot, cada
  réplica chama `upsertJobScheduler('retencao-horaria', { pattern: '0 * * * *' })`
  (idempotente — o Redis guarda um scheduler só) e o `RetentionProcessor`
  executa a varredura em uma réplica por hora. Antes era `@Cron`
  (`@nestjs/schedule`, removido).
- A cada hora, varre `documents` com `deletado_em is null`, `storage_path`
  presente e `expira_em` vencido. Para cada um: remove o arquivo do Storage,
  depois `storage_path = null` + `deletado_em = now()`. **Nunca** apaga a
  linha de `documents` nem toca em `analyses` — só o binário original some.
- Erro num documento não derruba a varredura dos demais (loop com
  try/catch por item, contadores de `processados`/`falhas` no log).
- A exclusão antecipada pelo usuário (`DELETE /api/documents/:id`) já existia
  desde a Fase 3 e tem o mesmo efeito final — só que disparada por request,
  não pelo cron.

### 5.3. Testando o hardening de segurança (Fase 8)

Dois scripts, cada um cobrindo uma parte do checklist:

```bash
cd backend
npm run malware-scan:test   # heurística de PDF + integração com o MalwareScanService
npm run security:test       # sobe a app de verdade (HTTP) e testa como um cliente externo
```

`malware-scan:test` roda a heurística direto contra um PDF limpo (gerado com
`pdf-lib`) e um PDF com marcadores de `/OpenAction`+`/JavaScript` embutidos, e
depois repete pelo `MalwareScanService` (cobre a integração via DI). Se
`ANTIVIRUS_ENABLED=true`, também testa a string **EICAR** — o arquivo de
teste padrão da indústria de antivírus (não é malware de verdade) — contra o
ClamAV configurado; sem isso, o teste do ClamAV é pulado (comportamento
esperado, não uma falha).

`security:test` é diferente dos outros scripts: ele sobe a aplicação real via
HTTP numa porta efêmera (`app.listen(0)`) e bate nela como um cliente externo
bateria — não chama services por dentro. Cria dois usuários (A e B), A sobe um
documento, e confere:

```
✅ Usuário A consegue ler o PRÓPRIO documento
✅ Usuário B NÃO consegue ler o documento do usuário A (espera 404) — status 404
✅ Usuário B NÃO consegue apagar o documento do usuário A (espera 404) — status 404
✅ Sem token de acesso, a rota responde 401 — status 401

Martelando POST /api/auth/login com senha errada...
  status codes: [401, 401, 401, 401, 401, 429, 429, 429]
✅ Rate limit estoura em algum momento (429) antes de esgotar as 8 tentativas
```

Isso é literalmente o critério de pronto da Fase 8 executado
("tentar acessar documento de outro usuário, tentar estourar rate limit").
Repare que o retorno pra um documento de outro usuário é **404, não 403** —
de propósito: um 403 revelaria que o documento existe (só que não é seu); o
404 não distingue "não existe" de "não é seu".

**O que mudou no backend:**

| Área | Antes da Fase 8 | Depois |
|---|---|---|
| Rate limit | 30/min uniforme em toda rota (`ThrottlerModule.forRoot`) | Continua 30/min de base, mas `POST /api/auth/login`\|`register` caem pra **5/min** e `POST /api/documents` pra **10/min** via `@Throttle({ default: {...} })` — cada rota já tinha bucket próprio (chave inclui o nome do handler), só o limite era frouxo demais pras duas mais sensíveis a abuso |
| Logs de auditoria | Só `upload`/`delete_document`/`register`/`login`/`login_failed` (senha errada)/`accept_terms`; `ip_address` sempre `null` | + `login_failed` também no caso de **e-mail desconhecido** (fechava um ponto cego de enumeração/brute-force sem rastro); + `logout`; + `refresh_token_reuse_detected` (evento de segurança — reaproveitar um refresh token já rotacionado); `ip_address` populado de verdade via `@Ip()` |
| Headers HTTP | `helmet()` só com os defaults | CSP explícita (`default-src 'none'`, apropriada pra uma API que não serve HTML), HSTS com `maxAge` de 180 dias, `crossOriginResourcePolicy: same-origin`. `TRUST_PROXY` (env, default off) liga `X-Forwarded-For` só quando de fato existe um reverse proxy na frente — necessário pra `req.ip` (rate limit e auditoria) refletir o IP real do cliente em produção |
| Antivírus no upload | TODO no código (`validateFile`) | `MalwareScanService`: heurística estática de PDF **sempre ativa** (rejeita `/JavaScript`, `/OpenAction`, `/Launch`, `/EmbeddedFile`, `/RichMedia` — os vetores mais comuns de PDF malicioso, sem precisar de nenhum serviço externo) + cliente ClamAV (`clamd`, protocolo `INSTREAM` implementado direto sobre `net`, **zero dependências novas**) plugável via `ANTIVIRUS_ENABLED` |

**Sobre o ClamAV — honestidade em vez de teatro de segurança:** o cliente
ClamAV é real e funcional (fala o protocolo `INSTREAM` de verdade), mas
**nenhum `clamd` roda neste ambiente de desenvolvimento** — não há
infraestrutura pra isso aqui. `ANTIVIRUS_ENABLED=false` por padrão, e o
backend avisa alto no boot (`ANTIVIRUS_ENABLED=false — uploads passam só pela
heurística estática...`) que a camada de assinaturas está desligada. Pra
ligar de verdade: suba um `clamd` (ex.: `docker run -p 3310:3310
clamav/clamav`) e aponte `CLAMAV_HOST`/`CLAMAV_PORT`. Com o antivírus ligado e
o `clamd` inacessível, o upload é **recusado** (fail closed) — nunca aceito
"sem verificar".

**Checklist de segurança da spec (seção 11), revisado item a item:**

| Item | Status | Observação |
|---|---|---|
| JWT (access curto + refresh rotativo, RS256) | ✅ | Fase 1 |
| Hash de senha com bcrypt | ✅ | custo 12, Fase 1 |
| RBAC + RLS no Supabase | ✅ RBAC · ⚠️ RLS | RBAC real via guards. RLS está ligado nas 5 tabelas mas **sem nenhuma policy** — funciona como "nega tudo" pra `anon`/`authenticated`. A fronteira de autorização que efetivamente protege os dados hoje é a **aplicação** (`service_role` bypassa RLS; toda query já filtra por `user_id`) — RLS é defesa em profundidade caso algo um dia acesse o Postgres direto. Ver verificação manual abaixo |
| Rate limiting (login e uploads) | ✅ | Fase 8 — limites dedicados, ver tabela acima |
| CORS restrito + Helmet + HSTS | ✅ | CORS restrito ao `FRONTEND_URL` desde a Fase 0; CSP/HSTS explícitos desde a Fase 8 |
| Validação de tipo/tamanho de arquivo + antivírus | ✅ tipo/tamanho · ⚠️ antivírus | Magic bytes + limite de 20MB desde a Fase 3. Antivírus: heurística sempre ativa + ClamAV plugável, mas **desligado por padrão** neste ambiente (ver acima) |
| Storage privado com signed URLs | ✅ (mais forte) | Bucket privado, e hoje **não existe nenhum endpoint** que exponha o arquivo original — nem signed URL, nem público. O frontend só vê o resultado da análise. Se um endpoint de download for adicionado no futuro, precisa usar `createSignedUrl` com TTL curto |
| Secrets fora do código-fonte | ✅ | `.env` fora do git desde o início (`.gitignore`) |
| Logs de auditoria | ✅ | Fase 8 — cobertura ampliada, IP real, ver tabela acima |
| Termo de Uso com aceite obrigatório e versionado | ✅ | Fase 2 |
| Retenção de 72h com deleção automática | ✅ | Fase 7 |
| `area_negocio` obrigatório no upload | ✅ | Fase 3/4 |
| Templates de prompt exaustivos por cenário | ✅ (6 de 6 áreas) | Fase 4 (`juridico`) + Fase 9 (`financas`, `imobiliario`, `rh`, `saude`, `outro`) |
| Veredito de compliance estruturado por item | ✅ | Fase 4 |
| Aviso de que a análise não substitui parecer profissional | ✅ | campo `aviso_legal`, Fase 4 |

**Verificação manual da postura de RLS** (não dá pra automatizar sem a `anon
key`, que não fica no `.env` do backend de propósito): pegue a `anon key` do
seu projeto (Project Settings → API) e rode

```bash
curl "https://SEU-PROJETO.supabase.co/rest/v1/documents?select=*" \
  -H "apikey: SUA_ANON_KEY" -H "Authorization: Bearer SUA_ANON_KEY"
```

Esperado: `[]` — RLS ligado, zero policies, nega tudo pra quem não é
`service_role`.

## 6. Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
# App em http://localhost:3000
```

## Fluxo esperado (via frontend)

1. `/register` → cria conta → redireciona para `/termos`.
2. `/termos` → aceite obrigatório → redireciona para `/upload`.
3. `/upload` → escolhe área de negócio, envia PDF/CSV/XLSX → lista os
   documentos do usuário, cada um com o status atual (o upload já dispara a
   análise — Fase 5) e clicável.
4. Clicar num documento abre `/documentos/[id]`: enquanto `uploaded`/
   `processing`, a tela faz polling sozinha (a cada 4s) até virar `done` ou
   `error`; quando `done`, mostra o resultado completo (resumo executivo,
   veredito geral, checklist item a item com severidade/evidência/sugestão,
   dados faltantes, sugestões de melhoria e o aviso legal).

Sem aceitar o termo, `/api/documents/*` responde `403 Forbidden`
(`TermsAcceptedGuard`) mesmo com um access token válido.

## Arquitetura por fase — o que foi feito e como escala

Cada fase abaixo traz: **o que faz**, **o que foi implementado** e uma análise
de **escala horizontal** (rodar N instâncias do backend atrás de um load
balancer). O que faz um serviço quebrar ao escalar é *estado guardado na
memória do processo*; estado no Postgres/Storage (compartilhado) ou calculado
por requisição escala liso.

### Resumo

| Fase | Escala horizontal hoje? | O que falta para escalar |
|---|---|---|
| 0 — Infra | ✅ Sim (resolvido) | Era o rate limiter em RAM; agora os contadores ficam no Redis (Etapa 2) |
| 1 — Auth | ✅ Sim | Nada (só as chaves RS256 idênticas em todas as instâncias) |
| 2 — Autorização / Termo | ✅ Sim | Nada |
| 3 — Upload | ✅ Sim | Nada (atenção operacional: Multer bufferiza em RAM) |
| 4 — IA (função isolada) | ✅ Sim | Nada no código (cuidado com o rate limit externo da OpenRouter) |
| 5 — Pipeline assíncrono | ✅ Sim (resolvido) | Era a fila in-process; agora é BullMQ + Redis (Etapa 4) |
| 6 — Frontend de status/resultado | ✅ Sim | Nada (frontend é stateless; atenção é ao **volume de polling** que ele gera no backend) |
| 7 — Retenção de 72h | ✅ Sim (resolvido) | Era o `@Cron` por processo; agora é um job repetível do BullMQ, uma execução por hora (Etapa 5) |
| 8 — Hardening de segurança | ✅ Sim | Nada de novo — herda a ressalva do rate limiter da Fase 0 (mesmo Redis resolve). ClamAV, se ligado, é um serviço externo compartilhado como o Supabase (todas as instâncias apontam pro mesmo `clamd`), não estado por instância |
| 9 — Expansão de templates | ✅ Sim | Nada — mesmo perfil da Fase 4 (templates são strings estáticas em código, zero estado, zero banco) |

**Conclusão:** adicionar **um único Redis** resolveu a Fase 0 (rate limit
distribuído), a Fase 5 (fila durável e compartilhada) e a Fase 7 (repeatable
job do BullMQ roda uma vez só, não por instância). Os detalhes, os testes e as
limitações que sobraram estão na seção "Escalabilidade horizontal". *As
tabelas por fase abaixo descrevem o estado de cada fase quando foi entregue e
trazem uma nota "Atualização" onde o Redis mudou o quadro.*

---

### Fase 0 — Fundamentos e Infraestrutura

**O que faz:** deixa o esqueleto rodando, sem lógica de negócio.

**Implementado:** projeto NestJS (backend) + Next.js 16 App Router (frontend);
`ConfigModule` carregando `.env` via `configuration.ts`; `helmet`, CORS restrito
ao `FRONTEND_URL`, `ValidationPipe` global (whitelist + forbidNonWhitelisted);
`ThrottlerModule` (rate limit); `HttpExceptionFilter` global; health-check
`GET /api/health`; `SupabaseService` (client único com a `service_role` key,
`@Global`).

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| Config (`.env` / `ConfigModule`) | Lido no boot, imutável | ✅ (mesmo `.env` em todas as instâncias) |
| Helmet / CORS / ValidationPipe | Stateless, por requisição | ✅ |
| Health-check | Stateless | ✅ |
| `SupabaseService` | Client HTTP, sem estado local; fala com Postgres/Storage compartilhados | ✅ |
| **`ThrottlerModule` (rate limit)** | **Contadores em memória** (`ThrottlerModule.forRoot` sem storage) | ⚠️ Com N instâncias o limite efetivo vira `N × 30/min`; não quebra, mas afrouxa e um atacante que caia em instâncias diferentes contorna parte do limite |

**Para escalar:** trocar o storage do throttler por um compartilhado
(`@nest-lab/throttler-storage-redis`). É o mesmo Redis que a Fase 5 vai querer.

> **Atualização:** feito (Etapa 2 de "Escalabilidade horizontal"). Os contadores
> do rate limit ficam no Redis; o limite vale somado entre todas as réplicas
> (provado: 5 logins passam, o 6º dá `429`, mesmo alternando entre réplicas).

---

### Fase 1 — Autenticação

**O que faz:** cadastro, login e emissão/renovação de JWT ponta a ponta.

**Implementado:** `POST /api/auth/register | login | refresh | logout`. Senha
com **bcrypt** (custo 12), nunca logada. **Access token** JWT **RS256**, 15 min,
validado com a chave pública. **Refresh token** opaco (aleatório), guardado como
**hash SHA-256** em `refresh_tokens`, **rotacionado a cada uso**, entregue em
cookie `httpOnly` (7 dias). **Detecção de reuso:** se um refresh token já
rotacionado reaparece, toda a cadeia daquele usuário é revogada.

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| Validação do access token (`JwtStrategy`) | Stateless — só verifica a assinatura com a chave pública | ✅ |
| Emissão do access token | Precisa da chave privada (no `.env`) | ✅ |
| bcrypt (hash / compare) | CPU pura, sem estado | ✅ |
| Refresh token (rotação / revogação / reuso) | Postgres (`refresh_tokens`) | ✅ |

**Para escalar:** nada. Auth é stateless (JWT) ou lastreada no banco. Única
exigência: **as chaves RS256 idênticas em todas as instâncias** — em produção,
via secrets manager do provedor, não `.env` copiado à mão.

---

### Fase 2 — Autorização e Termo de Uso

**O que faz:** RBAC + bloqueio de upload/análise enquanto o Termo de Uso vigente
não for aceito.

**Implementado:** roles `user` / `admin` (`@Roles()` + `RolesGuard`).
`TermsAcceptedGuard` protege `/api/documents/*` e `/api/analyses/*`: consulta
`users.terms_accepted` + `users.terms_version` **no banco a cada request**
(o aceite pode ocorrer depois de o token já ter sido emitido). `POST
/api/auth/accept-terms` grava versão + timestamp. Sem aceite, resposta é
`403 Forbidden` mesmo com access token válido.

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| `RolesGuard` | Role vem do payload do JWT | ✅ |
| `TermsAcceptedGuard` | Postgres (`users`) — 1 query por request nas rotas protegidas | ✅ |
| Versão vigente do termo | Env `TERMS_CURRENT_VERSION` | ✅ (igual em todas as instâncias) |

**Para escalar:** nada. Opcional, se a query por request incomodar sob carga
alta: cache curto do `terms_accepted` por usuário (Redis, TTL de segundos).
Não é gargalo real hoje.

---

### Fase 3 — Upload de Documentos

**O que faz:** recebe o arquivo + `area_negocio`, valida, guarda no Storage e
registra no banco com expiração de 72h.

**Implementado:** `POST /api/documents` (multipart). **Validação de MIME real
por magic bytes** (`file-type`), não pela extensão; CSV puro cai num fallback
"parece texto". Limite de 20MB (hard cap no interceptor + checagem fina no
service). Upload para o **Supabase Storage** (bucket privado) em
`{userId}/{docId}-{nome}`. `documents` gravado com `expira_em = now + 72h`.
`GET /api/documents`, `GET /api/documents/:id`, `DELETE /api/documents/:id`
(remove do Storage best-effort + marca `deletado_em`). Todas as queries
filtram por dono.

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| Validação de magic bytes | Buffer em memória, por request, efêmero | ✅ |
| Multer (`FileInterceptor`, `memoryStorage`) | Arquivo em RAM durante o request | ✅ (pressão de memória por instância, não é bug de correção) |
| Upload / download | Supabase Storage (externo, compartilhado) | ✅ |
| Registro / listagem / exclusão | Postgres (`documents`) | ✅ |

**Para escalar:** nada no código. Atenção operacional: muitos uploads grandes
simultâneos consomem RAM da instância (Multer bufferiza em memória) — sob
volume alto, migrar para streaming direto ao Storage ou `diskStorage`.

---

### Fase 4 — Integração com a IA (template piloto `juridico`)

**O que faz:** dado um documento (buffer + tipo + área), devolve uma análise de
compliance validada estruturalmente. Função pura, sem banco — testável isolada.

**Implementado:** `AnalysisService.analyze()`. Extração de texto (PDF via
`unpdf`, CSV via `papaparse`, XLSX via `exceljs`). `getPromptTemplate(area)`
escolhe o system prompt (só `juridico` nesta fase; checklist exaustivo de 23
itens, referencial normativo, anti-alucinação, schema JSON rígido — as outras
5 áreas ganham o mesmo tratamento na Fase 9). `OpenRouterClient`
chama a **OpenRouter** (formato chat-completions) com timeout, retry + backoff
exponencial e tratamento de erro que vem no corpo com HTTP 200. A resposta passa
por `parseJsonLoose` (tolera cerca markdown, `{{` duplicado, texto solto) e por
**validação Zod** (`AnalysisResultSchema`) — resposta fora do schema vira
`InvalidAnalysisResponseError`, **nunca é persistida**. Validada pelo golden set
(`npm run golden:build` + `golden:test`, seção 5).

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| Extração de texto | CPU / memória por request, efêmero | ✅ |
| Seleção de template | Constante em código | ✅ |
| `OpenRouterClient` | Chamada HTTP sem estado local (o retry vive dentro da própria chamada) | ✅ |
| Validação Zod | Pura | ✅ |

**Para escalar:** nada — `analyze()` não tem estado nem banco. O limite real é
**externo**: o rate limit da OpenRouter (agressivo na camada grátis). Com N
instâncias chamando em paralelo é mais fácil bater no `429` — mitigado pelo
`ANALYSIS_CONCURRENCY` (Fase 5) e, idealmente, por um rate limiter compartilhado
(Redis) ou uma chave paga.

---

### Fase 5 — Pipeline Assíncrono e Persistência

**O que faz:** conecta upload → análise → resultado salvo, sem travar a resposta
HTTP do upload.

**Implementado:** `DocumentsService.upload()` chama
`analysisRunner.enqueue(id)` **sem `await`** (resposta volta na hora com
`status: uploaded`). `AnalysisRunnerService` — fila em memória, concorrência
`ANALYSIS_CONCURRENCY` — para cada job: `status: processing` → baixa do Storage
→ `analyze()` → **upsert** em `analyses` (`unique(document_id)`, idempotente) →
`status: done`; qualquer erro → `status: error` + `documents.erro`. No boot,
`recoverPending()` reenfileira documentos presos em `uploaded` ou `processing`
antigo. `GET /api/analyses/:id` (checagem de dono via join). `GET
/api/documents/:id` passa a embutir `analise`.

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| **Fila de jobs** | **Array na RAM do processo** | ❌ Cada instância teria a sua, sem coordenação |
| `recoverPending()` no boot | Lê do Postgres | ⚠️ N instâncias competiriam pelo mesmo documento; o `unique(document_id)` evita linha duplicada, mas duas instâncias gastariam a chamada à IA |
| Persistência do resultado | Postgres (`analyses`, upsert idempotente) | ✅ |
| Status do documento | Postgres (`documents`) | ✅ |
| Leitura (`GET /api/analyses/:id`) | Postgres | ✅ |

**Para escalar:** **é a única fase que quebra de fato.** Trocar o
`AnalysisRunnerService` por **BullMQ + Redis** — fila compartilhada e durável,
worker isolável do servidor HTTP. A migração é localizada (`enqueue()` vira
`queue.add()`, o loop vira `new Worker()`), sem tocar em `DocumentsService`,
controllers ou schema. Comparação completa e gatilho de migração na
**seção 5.1**.

> **Atualização:** feito (Etapa 4 de "Escalabilidade horizontal"). A fila é
> BullMQ no Redis; qualquer réplica enfileira e qualquer worker processa.
> Provado com 3 réplicas: cada documento é processado exatamente uma vez sob
> enfileiramentos simultâneos, e a queda de uma réplica no meio de uma análise
> não perde o documento. Os limites que ficaram estão na seção
> "Limitações conhecidas".

---

### Fase 6 — Frontend de Upload e Resultado

**O que faz:** interface para usar o fluxo completo sem tocar em código —
login/cadastro, aceite de termo, upload, status e resultado.

**Implementado:** login/cadastro/termo já existiam (Fases 0-3). Novidades desta
fase: a lista em `/upload` agora faz **polling** (a cada 4s, só enquanto algum
documento estiver `uploaded`/`processing`) e cada item é um link; nova página
`/documentos/[id]` que também faz polling e, quando `status: done`, renderiza o
resultado completo — `resumo_executivo`, badge do veredito geral
(`conforme`/`nao_conforme`/`parcial`/`nao_verificavel`), o checklist item a
item (nome, veredito, severidade, referência normativa, evidência entre aspas,
sugestão de correção), `dados_faltantes`, `sugestoes_melhoria` e o
`aviso_legal`. Em caso de `status: error`, mostra a mensagem de
`documents.erro`. Tipos e rótulos (`AreaNegocio`, `StatusComplianceGeral`,
`Severidade`, cores dos badges) centralizados em `src/lib/domain.ts` para não
duplicar entre as duas páginas.

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| Next.js (páginas, build) | Stateless — SSR/estático, sem sessão de servidor | ✅ qualquer número de instâncias ou CDN |
| Access token | Memória do módulo JS, por aba do navegador — não é estado de servidor | ✅ (cada aba reobtém via refresh cookie ao recarregar) |
| Polling (`/upload`, `/documentos/[id]`) | Nenhum estado — é só o cliente repetindo a requisição HTTP | ⚠️ Não quebra, mas **soma carga de leitura no backend**: N usuários com abas abertas em documentos `processing` = N requisições a cada 4s |

**Para escalar:** nada no frontend em si — é stateless por natureza. O ponto de
atenção é o **volume de polling** gerado no backend sob muitos usuários
simultâneos com análises em andamento. Mitigações, se o volume justificar:
backoff progressivo no intervalo (4s → 8s → 15s quanto mais tempo em
`processing`), ou trocar polling por push (SSE/WebSocket) avisando quando o
status muda.

---

### Fase 7 — Retenção de 72h

**O que faz:** automatiza a exclusão do arquivo original 72h após o upload —
minimização de dados (LGPD, art. 6º, III), reduzindo a janela de exposição do
documento sem perder o resultado da análise.

**Implementado:** `RetentionService.purgeExpired()`, decorado com
`@Cron(CronExpression.EVERY_HOUR)` (`@nestjs/schedule`, habilitado via
`ScheduleModule.forRoot()`). A cada hora, varre `documents` com `deletado_em
is null`, `storage_path` presente e `expira_em` vencido; para cada um, remove
o arquivo do Storage e grava `storage_path = null` + `deletado_em = now()` —
**a linha de `documents` e o registro em `analyses` nunca são apagados**, só o
binário original some. Erro num documento não interrompe a varredura dos
demais. A exclusão antecipada pelo usuário (`DELETE /api/documents/:id`) já
existia desde a Fase 3 e produz o mesmo efeito final. Validado por
`npm run retention:test` (seção 5.2): documento com `expira_em` forçado para o
passado é limpo, um documento de controle com `expira_em` no futuro não é
tocado, e a `analyses` associada ao documento limpo continua intacta.

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| **Agendamento do `@Cron`** | **Registrado por processo** (o `ScheduleModule` de cada instância dispara o seu próprio timer) | ⚠️ Com N instâncias, todas rodam a mesma varredura na mesma hora — cada uma tenta limpar os mesmos documentos expirados |
| Query dos documentos expirados | Postgres (`documents`) | ✅ |
| Remoção do Storage + atualização do documento | Supabase Storage + Postgres (compartilhados) | ✅ **idempotente** — reprocessar um documento já limpo não corrompe nada (`storage_path` já é `null`, o update vira no-op); só desperdiça uma chamada ao Storage |
| Exclusão antecipada (`DELETE /api/documents/:id`) | Por request, sem estado local | ✅ |

**Para escalar:** o efeito final é sempre correto (idempotente), mas com N
instâncias o trabalho é duplicado N vezes toda hora — nada quebra, só
desperdiça chamadas ao Storage. Para eliminar de vez a duplicação: um lock
distribuído (`pg_try_advisory_lock` no Postgres, só uma instância "ganha" a
execução daquela hora), rodar a varredura como `pg_cron` no próprio Supabase
em vez de no processo do backend, ou — se o Redis da Fase 5 já existir —
migrar para um *repeatable job* do BullMQ, que roda uma vez só independente de
quantas instâncias do worker estejam de pé.

> **Atualização:** feito (Etapa 5 de "Escalabilidade horizontal"), pela última
> opção: o `@Cron` virou um job repetível do BullMQ e o `ScheduleModule` /
> `@nestjs/schedule` foram removidos. Com 2 réplicas no mesmo Redis ficou um
> único scheduler e um job disparado manualmente foi executado por uma réplica
> só.

---

### Fase 8 — Hardening de Segurança

**O que faz:** fecha as lacunas de segurança do checklist da spec antes de
uma exposição pública de verdade.

**Implementado:** rate limit dedicado em login/registro (5/min) e upload
(10/min), além do 30/min geral já existente desde a Fase 0. Logs de auditoria
ampliados — `login_failed` passa a cobrir e-mail desconhecido (não só senha
errada), mais `logout` e `refresh_token_reuse_detected` (evento de segurança:
reaproveitar um refresh token já rotacionado) — todos agora com o IP real do
cliente (`@Ip()`, com `TRUST_PROXY` controlando se `X-Forwarded-For` é
confiável). Helmet com CSP e HSTS explícitos em vez dos defaults genéricos.
`MalwareScanService`: heurística estática de PDF sempre ativa (sem
dependência externa) mais um cliente ClamAV real (protocolo `INSTREAM`
implementado sobre `net`, zero dependências novas), plugável via
`ANTIVIRUS_ENABLED` e com postura *fail closed* se ligado e inacessível.
Revisão completa do checklist de segurança da spec, item a item (seção 5.3).
Validado por dois scripts: `npm run malware-scan:test` (heurística + ClamAV
quando configurado) e `npm run security:test` — que sobe a aplicação real via
HTTP e prova, como um cliente externo provaria, que um usuário não acessa
documento de outro (404) e que o rate limit do login realmente barra depois
de 5 tentativas (429).

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| Rate limit dedicado (login/upload) | Mesmo mecanismo da Fase 0 — contadores em RAM, por processo | ⚠️ Herda a mesma ressalva: com N instâncias, o limite efetivo por rota vira `N × limite` |
| Logs de auditoria | Postgres (`audit_logs`) | ✅ |
| Heurística de PDF | Pura, por requisição, sem estado | ✅ |
| ClamAV (`clamd`) | Serviço externo (TCP), compartilhável entre instâncias | ✅ desde que `CLAMAV_HOST` aponte pra um `clamd` alcançável por todas — não pode ser `localhost` a menos que cada instância rode o seu próprio |
| Headers HTTP (Helmet) | Stateless, por requisição | ✅ |

**Para escalar:** nada novo — a Fase 8 não introduz estado próprio, só reusa
os mecanismos existentes (throttler in-memory da Fase 0, Postgres, e um
serviço externo opcional). A mesma correção da Fase 0 (throttler com storage
em Redis) resolve o rate limit dedicado também.

---

### Fase 9 — Expansão de Templates (demais áreas)

**O que faz:** sai de 1 área piloto (`juridico`) para as 6 áreas planejadas
na spec.

**Implementado:** 5 templates novos (`financas.prompt.ts`,
`imobiliario.prompt.ts`, `rh.prompt.ts`, `saude.prompt.ts`,
`outro.prompt.ts`), cada um seguindo o mesmo rigor da seção 6.2 da spec que já
valia pro `juridico`: checklist exaustivo de 15-23 itens específicos do
domínio, referencial normativo real (CPC/CFC para `financas`; Lei 6.015/73,
Lei 8.245/91 e CRECI para `imobiliario`; CLT e eSocial para `rh`; normas
administrativas de prontuário do CFM/ANS para `saude`), anti-alucinação,
nenhuma lacuna silenciosa, e uma seção dedicada a padrões de fraude/
irregularidade do nicho (lançamentos fictícios em `financas`, proprietário
divergente do registro em `imobiliario`, renúncia a direito trabalhista
indisponível em `rh`). `saude` tem uma regra extra, colocada antes até da
regra de anti-alucinação: o template avalia só **completude administrativa**
(campos preenchidos, identificação, assinatura) e está proibido de emitir
qualquer juízo sobre o mérito clínico do conteúdo — nunca avalia se um
diagnóstico está certo, só se o campo existe. `outro` é o único sem
referencial normativo fixo (a spec pede isso deliberadamente — documento pode
ser de qualquer natureza), mas mantém o mesmo checklist exaustivo de boas
práticas documentais.

Todas as 6 áreas compartilham o mesmo `AnalysisResultSchema` (Zod) e o mesmo
pipeline (`AnalysisService`, `AnalysisRunnerService`) — nenhuma mudança de
schema ou de banco foi necessária, só o roteamento em `getPromptTemplate()`
(`src/analysis/prompts/index.ts`), que agora é `Record<AreaNegocio,
PromptTemplate>` completo em vez de parcial.

`build-golden-set.ts` passou a gerar 12 fixtures (2 por área, mesmo padrão
"com problemas" / "bem estruturado" do `juridico`) e `test-golden-set.ts`
ficou genérico — roda todas as áreas em sequência (ou uma só, via
`npm run golden:test -- <area>`) e fecha com um resumo geral. Rodei a área
`financas` como prova de conceito: a análise capturou corretamente a
divergência de saldo, o lançamento duplicado, a variação de receita de +375%
sem explicação, e sinalizou os dois lançamentos idênticos como indício de
possível lançamento fictício — com evidências reais citadas do documento.
As outras 4 áreas novas (`imobiliario`, `rh`, `saude`, `outro`) ainda
precisam ser rodadas para validação completa (`npm run golden:test`).

| Componente | Onde vive o estado | Escala? |
|---|---|---|
| Templates de prompt | Constantes de string em código | ✅ |
| Seleção de template (`getPromptTemplate`) | Lookup síncrono em objeto, sem I/O | ✅ |
| Golden set (fixtures + script) | Arquivos locais, ferramenta de desenvolvimento | ✅ (não roda em produção) |

**Para escalar:** nada — mesmo perfil da Fase 4, zero estado novo. O único
"custo" de mais áreas é mais chamadas à IA por tipo de documento diferente,
que já era coberto pelo `ANALYSIS_CONCURRENCY` (Fase 5) e pelo rate limit da
OpenRouter (Fase 4/8).

---

## Escalabilidade horizontal — Redis, BullMQ e Nginx

Trabalho separado das Fases 0–9 do produto, feito em **8 etapas** (aqui
chamadas de *Etapas* para não confundir com as Fases). Objetivo: o backend ficar
**stateless** — nenhum estado importante na memória do processo — para rodar N
réplicas atrás de um load balancer, todas enxergando o mesmo rate limit, a
mesma fila e o mesmo agendamento.

```
                     ┌────────────┐
 cliente ──HTTP──►   │   Nginx    │  :8080   reparte as requisições (rodízio)
                     └─────┬──────┘
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
     backend-1        backend-2        backend-3      N réplicas idênticas,
     (API + worker)   (API + worker)   (API + worker)  sem estado local
          └────────────────┼────────────────┘
                           ▼
                        Redis  ──  rate limit · fila BullMQ · agendamento
                           ▲
     Supabase (Postgres + Storage) — dados e arquivos, também compartilhados
```

### Qual Compose usar

| Arquivo | Para quê | O que sobe |
|---|---|---|
| `docker-compose.yml` | **Desenvolvimento local** | Redis (porta 6379 aberta só em `127.0.0.1`) + 3 réplicas do backend + Nginx em `http://localhost:8080` |
| `docker-compose.test.yml` | **Só os scripts de teste** (complemento do anterior) | Alertas e varredura em intervalos curtos, webhook local em `:9099`. Nunca em produção |
| `docker-compose.prod.yml` | **Deploy** | Nginx com HTTPS (80/443) + backend (`BACKEND_REPLICAS`, padrão 2). **Sem Redis**: o `REDIS_URL` vem do `backend/.env.production` e aponta para o Redis gerenciado (`rediss://...`) |

Dois modos de rodar localmente:

```bash
# A) Backend fora do Docker (o dia a dia): só o Redis no Docker
docker compose up -d redis          # Redis em localhost:6379
cd backend && npm run start:dev     # API em http://localhost:3001

# B) Tudo no Docker (várias réplicas atrás do Nginx)
docker compose up -d --build        # API em http://localhost:8080
```

Em produção não existe `localhost` de aplicação: `REDIS_URL` com `localhost` faz o backend se
recusar a subir (validação de boot). Os únicos `localhost`/`127.0.0.1` do `docker-compose.prod.yml`
são os healthchecks, que rodam dentro do próprio container. Passo a passo do deploy em
"Migrar para produção". Se você der `docker compose down`, suba o Redis de novo (modo A) antes do
backend.

### Como subir o ambiente

```bash
# na raiz do repositório (precisa do backend/.env preenchido — seções 1 a 3)
docker compose up -d --build        # Redis + 3 réplicas + Nginx em http://localhost:8080
curl http://localhost:8080/api/health

docker compose up -d --no-recreate --scale backend=5 backend   # muda o nº de réplicas
docker compose down -v              # derruba tudo
```

- O Compose lê os segredos de `backend/.env` (nunca entram na imagem) e
  **sobrescreve** `REDIS_URL` (`redis://redis:6379`, o nome do serviço) e
  `TRUST_PROXY=true`. `backend/.env.example` e `frontend/.env.example` listam
  todas as variáveis (segredos como placeholders): `cp .env.example .env`.
- Para o frontend usar o load balancer, aponte `NEXT_PUBLIC_API_URL` para
  `http://localhost:8080` (hoje é `http://localhost:3001`).
- Rodando o backend fora do Docker (`npm run start:dev`), é preciso um Redis em
  `REDIS_URL` (default `redis://localhost:6379`): `docker compose up -d redis` (ver "Qual Compose usar").

| Variável | Para quê |
|---|---|
| `REDIS_URL` | Conexão com o Redis (rate limit, cache, BullMQ). Em produção, `rediss://` (TLS) com senha |
| `TRUST_PROXY` | `true` só atrás de um proxy conhecido: faz `req.ip` vir do `X-Forwarded-For` |
| `ENABLE_DEBUG_ENDPOINT` | `true` liga o `/api/debug/instance` (público, fora do rate limit). **Desligado por padrão** (responde 404); só o `docker-compose.yml` local o liga, para os testes. Nunca em produção |
| `ALERT_WEBHOOK_URL`, `ALERT_WEBHOOK_FORMAT`, `ALERT_CHECK_INTERVAL_MS`, `ALERT_COOLDOWN_MS` | Alertas de monitoramento (ver "Monitoramento e alertas") |
| `REFRESH_REVOKED_RETENTION_MS` | Quanto tempo um refresh token já usado fica no banco antes de o job de retenção apagá-lo (padrão 3600000 = 1 h, mínimo 1 min) |
| `ANALYSIS_CONCURRENCY` | **Sem efeito hoje**: a concorrência do worker é fixa em 2 por réplica (o decorator é avaliado antes do `.env` carregar) |
| `ANALYSIS_STUCK_TIMEOUT_MS` | Idade a partir da qual um documento em `processing` é reenfileirado (no boot e na varredura periódica) |
| `ANALYSIS_RECOVERY_INTERVAL_MS` | Intervalo da varredura periódica de documentos parados (padrão 300000 = 5 min) |

### Etapa 1 — Cliente Redis compartilhado

**O que faz:** uma conexão única com o Redis, injetável em qualquer módulo.
**Implementado:** `src/common/redis/redis.module.ts` (`@Global`, token
`REDIS_CLIENT` em `redis.constants.ts`), cliente `ioredis` com
`maxRetriesPerRequest: null` (exigido pelo BullMQ) e `quit()` no shutdown; `redis.url`
em `configuration.ts`. O BullMQ **não** reaproveita este cliente: workers usam
comandos bloqueantes e abrem conexões próprias.

### Etapa 2 — Rate limit no Redis

**O que faz:** o limite de requisições passa a valer somado entre as réplicas.
**Implementado:** `ThrottlerModule.forRootAsync` com
`ThrottlerStorageRedisService` sobre o `REDIS_CLIENT` (`app.module.ts`). Os
limites não mudaram (30/min geral, 5/min login e registro, 10/min upload).
**Provado:** 35 logins inválidos seguidos → 5×`401`, depois `429`; reiniciando o
backend, a primeira requisição já veio `429` (o contador não está na memória).

### Etapa 3 — Cache/contador e endpoint de diagnóstico

**O que faz:** prova, com um número visível, que o estado é compartilhado.
**Implementado:** `RedisCacheService` (`get`, `set` com TTL, `increment` via
`INCR`, atômico) e `GET /api/debug/instance`, que devolve `instanceId` (o
`HOSTNAME` do container), `hits` (contador no Redis), `ip` (o `req.ip` do rate
limit) e `timestamp`. É `@Public` e fora do rate limit de propósito (os testes
mandam centenas de requisições por minuto), por isso fica **desligado por
padrão**: sem `ENABLE_DEBUG_ENDPOINT=true` responde `404`, como se a rota não
existisse. Só o `docker-compose.yml` local o liga. **Provado:** dois backends alternando 5 chamadas → `hits` 1, 2, 3, 4, 5.

### Etapa 4 — Fila de análise no BullMQ

**O que faz:** o job de análise vive no Redis; qualquer réplica enfileira e
qualquer worker processa, uma réplica por job.
**Implementado:**

- `AnalysisQueueService` — produtor. `jobId = documentId`, com
  `removeOnComplete`/`removeOnFail`; falha ao enfileirar não derruba o upload
  (o documento fica `uploaded` e o `recoverPending()` do boot o reenfileira).
- `AnalysisProcessor` — worker, mesma lógica do antigo runner. Remove-se o
  `AnalysisRunnerService`.
- **Rede de segurança** `@OnWorkerEvent('failed')`: se o job falha de vez (ex.:
  travou duas vezes seguidas porque duas réplicas caíram no meio da análise), o
  documento vai para `status = 'error'` com a mensagem *"A análise foi
  interrompida por uma falha no servidor antes de terminar. Envie o documento
  novamente."* — o frontend já exibe `documents.erro`. Só mexe em documentos
  `uploaded`/`processing` (nunca sobrescreve um `done`) e tenta 3 vezes com
  espera, porque essa gravação é a única coisa que tira o documento de
  `processing`. Sem isso, o job sumia da fila e o documento ficava preso para
  sempre (defeito real, encontrado nos testes abaixo).

- **Tentativas ao gravar o status:** toda gravação em `documents` feita pelo
  worker (`processing`, `done`, `error`) tenta até 3 vezes (espera de 3 s e 6 s)
  antes de desistir.
- **Varredura periódica** (job repetível `recuperar-pendentes`, a cada
  `ANALYSIS_RECOVERY_INTERVAL_MS`): reenfileira documentos parados em
  `processing` há mais de `ANALYSIS_STUCK_TIMEOUT_MS` ou em `uploaded` há mais de
  2 min. É a última rede de segurança: cobre o caso em que o banco estava fora
  quando a análise terminou e nenhuma gravação de status funcionou, e o job já
  tinha ido embora da fila. O `jobId` evita duplicar um job que ainda está ativo.
  Todas as réplicas registram o mesmo scheduler (idempotente). Por isso a fila
  mostra sempre 1 job `delayed` (o próximo disparo da varredura).

- **Reivindicação condicional do documento:** o worker só passa o documento para `processing`
  com um `UPDATE` condicional (`status` em `uploaded`/`processing`/`error` e **não excluído**) que
  devolve as linhas alteradas; se não alterou nenhuma (outro worker concluiu o documento, ou o
  usuário o excluiu, entre a leitura e a gravação), o job para ali, sem chamar a IA e sem
  sobrescrever um `done` com `processing`.

**Duplicatas — o que a fila garante e o que não garante.** O Redis só aceita um
job novo se não existir outro com o mesmo `jobId`. Como o job é apagado ao
terminar (`removeOnComplete`), o id fica livre; uma cópia que chega *depois* do
original terminar vira um job novo. No teste de carga com jobs de ~10 ms,
286 de 3.000 jobs rodaram duas vezes por isso (3.286 execuções; cada um dos 286
rodou exatamente 2×). Com a fila pausada durante a rajada, deu 3.000 execuções
exatas. No app real a análise leva de 30 a 100 s e as cópias de um enqueue chegam
em milissegundos, então a janela não existe na prática; uma cópia tardia (ex.:
`recoverPending()`) é barrada pela checagem do banco — o worker ignora documento
já `done`. Essa checagem cobre `done` **e** `error` (estados finais): um job tardio para um
documento em `error` é ignorado e não o reanalisa.

### Concorrência nas escritas do banco

A fila do BullMQ controla **quem processa** cada análise; ela não protege escritas no banco, e
garante "ao menos uma vez", não "exatamente uma". Quem impede a corrida de escrita é o próprio
banco, com atualização condicional (só altera se o estado ainda for o esperado), restrição única e
`upsert`. Onde isso vale hoje:

| Escrita | Proteção |
|---|---|
| Rotação do refresh token (`/api/auth/refresh`) | `UPDATE ... WHERE revoked = false` atômico: de N chamadas simultâneas com o mesmo token, só **1** consegue; as outras caem no caminho de reuso (revogam a família e dão `401`). Antes eram dois passos (ler, depois revogar) e várias passavam: em 8 chamadas simultâneas, 5 deram certo e deixaram 5 tokens válidos |
| Cadastro (`/api/auth/register`) | O e-mail é único no banco. A leitura "já existe?" não protege sozinha (várias requisições passam por ela); a inserção que o banco recusa agora vira **409** limpo. Antes: 5 cadastros simultâneos com o mesmo e-mail deram 1× `201` e 4× `500`; agora 1× `201` e 4× `409` |
| Gravação da análise (`analyses`) | `unique(document_id)` + `upsert`: reprocessar não duplica |
| Status do documento ao iniciar a análise | Reivindicação condicional (acima): nunca sobrescreve `done` nem pega documento excluído |
| Status `error` (do handler de job falho **e** do `catch` do worker) | `UPDATE` restrito a `uploaded`/`processing`: um worker "zumbi" (que travou e perdeu o job para outro) que falha depois não sobrescreve o `done` do outro |
| Documento em `error` | É estado final: nada o reenfileira, e um job tardio para ele é ignorado (não é reanalisado) |
| Exclusão pelo usuário (duas ao mesmo tempo) | `UPDATE ... WHERE deletado_em IS NULL`: só a primeira altera e audita; a segunda é um sucesso silencioso, sem sobrescrever `deletado_em` nem duplicar a auditoria |
| Exclusão pelo usuário durante a análise | Sem trava: o arquivo some e o worker pode terminar com `error` (não achou o arquivo) ou, se já o tinha baixado, gravar o resultado. Pelo desenho (Fase 7) o resultado em `analyses` sobrevive à exclusão do arquivo |

**Consequência para o frontend:** como o refresh token é de uso único, duas renovações simultâneas
com o mesmo cookie derrubariam a sessão (a segunda é tratada como reuso). Por isso o cliente HTTP
(`frontend/src/lib/api.ts`) mantém **uma única renovação em andamento por vez**: chamadas que
recebem `401` ao mesmo tempo, e o efeito duplicado do `StrictMode`, compartilham a mesma
requisição. Ao abrir a página sem login isso cai de 4 chamadas ao `refresh` para 1.
**Várias abas do mesmo navegador** dividem o cookie, então também precisam se revezar: a renovação
passa por um lock entre abas (Web Locks API, `navigator.locks`). A aba que espera só envia a sua
requisição quando a outra terminou, já com o cookie novo, sem afrouxar nada no servidor (não há "janela
de tolerância" para reuso). Em navegador sem Web Locks fica só a proteção dentro da própria aba.

**Redis:** não há corrida de escrita nele. O rate limit usa contadores atômicos (biblioteca), o contador
de diagnóstico usa `INCR`, o cache de termos só guarda "já aceitou", e os agendadores e a repetição
dos alertas usam operações idempotentes (`upsertJobScheduler`, `SET ... NX`). A auditoria cobriu as 12
escritas no banco e as 3 do Redis.

### Carga no banco

Escalar réplicas não escala o banco: o que pesa nele é o quanto o sistema lê e escreve. Uma fila
na frente das escritas **não** reduz essa carga (só adia e arrisca perder escritas); o que reduz é
ler menos e não deixar tabelas crescerem sem limite. Auditoria do código, e o que foi feito:

| Fonte de carga | Antes | Agora |
|---|---|---|
| Checagem do aceite dos termos (guard de `/api/documents`) | 1 consulta ao banco em **toda** requisição de documentos, inclusive cada polling, sempre com o mesmo resultado para o mesmo usuário | Só o "já aceitou" fica em cache no Redis (`terms:ok:<usuário>:<versão>`, 5 min); quem não aceitou nunca é guardado; versão nova do termo invalida sozinha. Medido ao vivo: a chave aparece no Redis com TTL de 299 s |
| Polling de status (a tela consulta enquanto o documento está pendente) | A cada 4 s, 2 a 3 leituras por consulta | Intervalo crescente (`frontend/src/lib/polling.ts`): 4 s nas 5 primeiras, 8 s nas 5 seguintes, 15 s depois, 30 s com a aba oculta. Numa análise de 100 s: 25 → 12 consultas (52% a menos). Medido no navegador: 4,6 s, 8,3 s (5 vezes), 15,4 s, e 30,4 s com a aba oculta |
| Tabela `refresh_tokens` | **Só crescia**: cada renovação de sessão grava uma linha e nada apagava (até ~670 linhas por usuário ativo, 7 dias de rotações) | O job de retenção (a cada hora) apaga em lotes de 100 (até 50 lotes por passada) os **expirados** e os **revogados há mais de 1 hora** (`REFRESH_REVOKED_RETENTION_MS`, padrão 3600000, mínimo 1 min); um revogado só precisa existir para o reuso dele ser detectado como roubo, e essa janela é de ~1 h. Como o job roda de hora em hora, cada linha revogada vive de 1 a 2 h: com a sessão renovada a cada 15 min isso dá **até ~10 linhas por usuário ativo** (eram até ~670 sem limpeza; ~100 com a janela de 1 dia). Índices na migração 004 (já aplicada). Medido ao vivo: 250 expirados apagados pelo PostgREST real, válidos preservados, revogado de 2 h atrás apagado e o de 10 min atrás preservado |
| Varredura de documentos parados e retenção de 72h | Já usam índices (`idx_documents_pendentes`, `idx_documents_retencao`) | Sem mudança |

**O que continua pesando** (não resolvido):
- Cada consulta de polling ainda faz 1 a 2 leituras (o documento e, na tela de detalhe, a análise). Com
  muitos usuários esperando ao mesmo tempo isso continua sendo a maior fonte de leitura. A saída seria um
  cache curto do status ou notificação por servidor (SSE/WebSocket), que não foi feita.
- `refresh_tokens` ainda guarda uma linha por renovação por 1 a 2 horas (até ~10 por usuário ativo com a
  sessão renovada a cada 15 min). Guardar uma linha por renovação **não é necessário**: o desenho mínimo é
  uma linha por sessão, atualizada no lugar (hash atual e hash anterior; o `UPDATE ... WHERE hash = ...`
  já é a reivindicação atômica). Isso exige mudar a tabela e o código de autenticação (migração nova) e não
  foi feito. **Decisão de segurança:** não aumentei `JWT_ACCESS_EXPIRES_IN` (segue 15 min). Subir para 60 min
  reduziria as renovações em ~4×, mas um access token roubado não pode ser revogado e passaria a valer 4×
  mais; com a janela de 1 h o ganho já veio sem esse custo. **Efeito colateral da janela curta:** o reuso de
  um refresh token revogado há mais de ~1 h deixa de derrubar a sessão inteira (ele continua sendo recusado
  com 401, só não aciona a revogação da família nem o log `refresh_token_reuse_detected`). Se preferir
  detectar por mais tempo, aumente `REFRESH_REVOKED_RETENTION_MS`.
- `audit_logs` só cresce (login, upload, exclusão); não há retenção.
- Nada disso foi testado com carga real: os números acima são contas sobre o código e medidas pontuais.

### O que acontece se o Redis cair

Testado ao vivo (derrubando o Redis com 3 réplicas no ar). **Antes da correção a API inteira travava**,
inclusive o login e o `/api/health`: o guard de rate limit esperava o Redis responder antes de deixar
qualquer requisição passar (só o `/api/health/ready`, isento do rate limit, respondia). Em produção, uma
queda do Redis gerenciado derrubaria o site. Agora:

- **Rate limit:** tenta o Redis por até 500 ms e, se falhar, usa um contador em memória **daquela réplica**
  (`resilient-throttler-storage.ts`). O limite continua valendo, mas deixa de ser somado entre réplicas
  (com N réplicas fica até N vezes mais folgado) até o Redis voltar. O cliente Redis compartilhado passou a
  falhar na hora (`enableOfflineQueue: false`), em vez de enfileirar comandos esperando a volta.
- **Cache de termos:** a leitura falha e cai para o banco.
- **Fila de análises e agendamentos (BullMQ):** param até o Redis voltar. Uploads continuam sendo aceitos
  (o enfileiramento não bloqueia a resposta) e os documentos pendentes são resgatados pela varredura depois.
- **`/api/health/ready`:** responde `503` apontando o Redis; `/api/health` segue `200`.
- Os alertas de monitoramento também dependem do Redis, então **não** avisam sobre a própria queda dele:
  para isso serve o monitor externo (abaixo).

**Redis e escala horizontal:** o Redis escala para cima (instância maior) e, com Redis Cluster, também para
os lados (dados divididos entre nós). O que usamos é uma instância única; usar Cluster exigiria mudar o
código (cliente de cluster, prefixo das filas do BullMQ entre chaves para manter as chaves de uma fila no
mesmo nó, e o armazenamento do rate limit), o que não foi feito e não é necessário para a carga atual (o
Redis só guarda fila, contadores e cache).

### Monitoramento e alertas

Um job repetível (BullMQ, uma execução por minuto em **uma** réplica, `src/monitoring`) avalia o estado do
sistema e avisa por **webhook** quando uma condição aparece e quando ela some ("resolvido"). O mesmo alerta
não se repete dentro de `ALERT_COOLDOWN_MS` (depois disso vira um lembrete). Sem `ALERT_WEBHOOK_URL`, os
alertas só aparecem no log (`ALERTA [CRÍTICO] ...`), e a validação de produção avisa disso.

| Regra | Dispara quando | Gravidade |
|---|---|---|
| Documentos parados | há documento pendente (`uploaded`/`processing`) há mais de 15 min (a varredura deveria ter resgatado) | crítica |
| Taxa de erro alta | com pelo menos 5 análises finalizadas nos últimos 15 min, 50% ou mais terminaram em erro (falha ou limite do modelo de IA) | crítica |
| Banco inacessível | as consultas ao banco falham | crítica |
| Rotina parada | a retenção não roda há mais de 2,5 h, ou a varredura há mais de 4× o intervalo (mín. 15 min); cada rotina grava um batimento no Redis | crítica |
| Fila acumulada | mais de 50 análises esperando | aviso |
| Jobs falhos | algum job de análise falhou de vez nas últimas 2 h (ex.: workers que caíram) | aviso |

| Variável | Para quê |
|---|---|
| `ALERT_WEBHOOK_URL` | Endereço do webhook (Slack, Teams, Mattermost, Discord, Telegram via bot, ou o seu serviço) |
| `ALERT_WEBHOOK_FORMAT` | `slack` (campo `text`, o padrão), `discord` (campo `content`) ou `generic` (JSON completo: estado, regra, severidade, detalhe) |
| `ALERT_CHECK_INTERVAL_MS` | Intervalo da avaliação (padrão 60000) |
| `ALERT_COOLDOWN_MS` | Quanto tempo um alerta que continua disparado fica sem ser repetido (padrão 1800000 = 30 min) |

**Monitor externo de disponibilidade (necessário):** se o app inteiro cair, o job de alertas cai junto e não
avisa ninguém. O repositório traz um monitor que roda **fora** da sua infraestrutura:

- `backend/scripts/uptime-check.js` (sem dependências): consulta `GET /api/health/ready` (`200` = Redis e banco
  ok; `503` = algum fora; sem resposta = app/VM/Nginx fora), tenta 3 vezes com 10 s de intervalo antes de
  dar a queda como real (oscilação de 1 ou 2 tentativas não alerta), avisa pelo **mesmo webhook** e formato
  dos alertas internos e sai com código 1 quando está fora. Com `UPTIME_STATE_FILE` o aviso sai **uma vez por
  queda** e sai o "resolvido" na volta.
- `.github/workflows/uptime.yml`: agenda o script a cada 5 min no GitHub Actions (guarda o estado no cache do
  Actions). Para ligar, no repositório (Settings → Secrets and variables → Actions): variável `HEALTH_URL`
  (`https://SEU-DOMINIO/api/health/ready`), secret `ALERT_WEBHOOK_URL` e, opcional, variável
  `ALERT_WEBHOOK_FORMAT`. Sem `HEALTH_URL` o workflow não faz nada. Limites do GitHub: intervalo mínimo de
  5 min, agendamento "melhor esforço" (pode atrasar) e, em repositório público, workflows agendados são
  desativados após 60 dias sem atividade no repositório. Para checar a cada 1 min, use um monitor dedicado
  (qualquer serviço de uptime) apontado para a mesma URL, esperando `200`; ele pode conviver com este.

O `/api/health` continua sendo só a vida do processo (healthcheck do container). O `/api/health/ready` tem
cache de 5 s por réplica e é público como qualquer rota: use intervalo de 30 s ou mais.

### Etapa 5 — Retenção de 72h como job repetível

Ver Fase 7. `RetentionService` agenda a varredura com `upsertJobScheduler`
(idempotente) e `RetentionProcessor` a executa; `@nestjs/schedule` foi removido.
**Provado:** com 2 réplicas, um único scheduler no Redis e um job manual
executado por uma réplica só; `npm run retention:test` continua passando.

### Etapa 6 — Dockerfile do backend

**Implementado:** `backend/Dockerfile` multi-stage (`node:22-alpine`: build com
devDependencies → dependências só de produção → runtime enxuto), roda como o
usuário `node`, 404 MB. `.dockerignore` deixa de fora `.env`, `*.pem`, `scripts`,
`sql` e `test-fixtures`: **segredos nunca entram na imagem**, vêm por variável de
ambiente. **Provado:** o `bcrypt` nativo carrega no Alpine; não há `.env` nem `.pem`
dentro da imagem; sobe, conecta no Redis e responde `/api/health`.

### Etapa 7 — Docker Compose com várias réplicas

**Implementado:** `docker-compose.yml` — Redis (`redis:7-alpine`, AOF ligado, com
volume, para a fila sobreviver a um restart) e `backend` com `replicas: 3`,
healthchecks e `depends_on` com `service_healthy`. O backend não publica porta
(várias réplicas não dividem uma porta do host). O `env_file` do Compose remove as
aspas das chaves JWT do `.env`, o que `docker run --env-file` não faz.
`docker-compose.test.yml` é um override só de testes que expõe o Redis em
`localhost:6379`. **Provado:** as 3 réplicas conectam no mesmo Redis (nome do
serviço, não `localhost`), o contador de `/api/debug/instance` sobe sem repetir
entre elas e o limite de login vale somado.

### Etapa 8 — Nginx na frente

**O que faz:** única porta de entrada (`:8080`) e distribuição das requisições.
**Implementado:** `nginx/nginx.conf` + serviço `nginx` no Compose.

- O nome `backend` é resolvido pelo DNS do Docker (`127.0.0.11`, `valid=5s`) por
  **variável** no `proxy_pass`, então réplicas criadas ou removidas com `--scale`
  entram e saem da rotação sem reiniciar o Nginx.
- `X-Forwarded-For` é **sobrescrito** com o IP de quem conectou (não acrescentado):
  o cliente não consegue forjar o IP, e o backend (`TRUST_PROXY=true`) usa esse IP
  no rate limit e na auditoria.
- `client_max_body_size 25m` (uploads de até 20 MB; o padrão do Nginx, 1 MB,
  devolveria `413` antes de chegar ao backend).
- Tenta a próxima réplica se uma não responde ao conectar; não repete POST já enviado.
- O healthcheck usa `127.0.0.1`: no container, `localhost` resolve para IPv6 e o
  Nginx só escuta em IPv4.

### Como foi testado

| Script | O que exercita | Resultado |
|---|---|---|
| `backend/scripts/test-queue-race.ts` | 6 a 20 documentos reais, cada um enfileirado 15× ao mesmo tempo por 3 produtores independentes, 3 réplicas consumindo; replay de documentos `done`; com `--kill`, mata uma réplica no meio da análise | Cada documento processado exatamente 1×, 0 linhas duplicadas em `analyses`, 0 reanálises no replay; com a réplica morta, todos terminaram (20 docs / 300 enqueues: 18 `done`, 2 `error` por resposta da IA fora do schema) |
| `backend/scripts/test-double-stall.ts` | Mata duas réplicas em sequência durante a análise do mesmo documento | Antes da correção: documento preso em `processing`. Depois: `error` com a mensagem ao usuário |
| **Frontend no navegador atrás do Nginx** (manual: `NEXT_PUBLIC_API_URL=http://localhost:8080 npm run dev` em `frontend/`, com o Compose local no ar) | Fluxo real de usuário: cadastro, aceite de termos, recarregar a página (a sessão volta pelo cookie `httpOnly` via `/api/auth/refresh`), upload de um PDF, polling do status na lista, tela de erro, tela de resultado, sair e entrar de novo | Tudo funcionou: todas as chamadas passaram por `localhost:8080` com CORS (preflight `204`), sem erro de CORS no console; o upload foi processado por uma réplica, a lista atualizou sozinha de "Processando" para "Concluído" e o resultado mostrou resumo, selo de conformidade e checklist de 23 itens. Um documento terminou em "Erro" por resposta da IA fora do schema (a falha conhecida do modelo gratuito), e a tela mostrou a mensagem com o convite a reenviar |
| `backend/scripts/test-status-retry.ts` (`npm run status-retry:test`) | **Offline** (sem Redis/Supabase/IA): simula o banco falhando ao gravar o status e confere as tentativas, a seleção da varredura, o handler de `failed` a reivindicação condicional (não sobrescreve `done`, não pega excluído, a janela entre a leitura e a gravação), `error` como estado final e o worker zumbi | 20 de 20 verificações passaram |
| `backend/scripts/test-recovery-sweep.ts` | **Ao vivo**: cria um documento `processing` há 15 min e outro `uploaded` há 10 min, sem nenhum job na fila, e deixa o scheduler resgatá-los | 5 de 5: um único scheduler apesar de 3 réplicas; os dois documentos concluídos; cada um processado 1× |
| `backend/scripts/test-production-checks.ts` (`npm run prod-checks:test`) | **Offline**: a validação de configuração de produção — cada regra, o que é erro (aborta o boot) e o que é só aviso, e que fora de produção ela não interfere | 18 de 18 verificações passaram |
| `backend/scripts/test-redis-tls.sh` | O backend contra um **Redis com TLS e senha** (certificados descartáveis, containers temporários): conexão `rediss://`, contador, rate limit, schedulers e um job consumido pelo worker do BullMQ, `/api/debug` desligado = 404, e três casos negativos (sem a CA, senha errada, política `allkeys-lru`) | 14 de 14 verificações passaram |
| `backend/scripts/test-refresh-race.js` | **Ao vivo**, pela API (3 réplicas atrás do Nginx): N chamadas simultâneas a `/api/auth/refresh` com o MESMO cookie | Antes da correção: 8 chamadas, **5** deram certo e 5 tokens válidos sobraram. Depois: 1 dá certo e no máximo 1 token válido sobra, em 6, 12 e 18 chamadas paralelas |
| `backend/scripts/test-frontend-single-flight.ts` (`npm run frontend-refresh:test`) | **Offline**: a renovação única do frontend (`fetch` falso que conta as chamadas) | 8 de 8: 6 renovações simultâneas = 1 requisição; 5 chamadas com token expirado = 1 renovação; sequenciais = 1 cada; a trava é liberada depois de uma falha |
| `backend/scripts/test-db-load.ts` (`npm run db-load:test`) | **Offline**: cache dos termos (1 consulta em 5 requisições, quem não aceitou não é guardado, versão nova invalida, erro do Redis cai para o banco), limpeza de tokens expirados em lotes, janela dos revogados (1 h padrão, configurável, valores absurdos corrigidos) e o intervalo crescente do polling | 16 de 16 verificações passaram |
| `backend/scripts/test-db-load-live.js` | **Ao vivo** (Supabase e Redis reais, 3 réplicas): a chave de cache dos termos no Redis, o 403 de quem não aceitou, o job de retenção apagando 250 tokens expirados e a janela de 1 h dos revogados (some o de 2 h atrás, fica o de 10 min) | 8 de 8 verificações passaram |
| `backend/scripts/test-register-race.js` | **Ao vivo**: 5 cadastros simultâneos com o MESMO e-mail | Antes: 1× `201` e 4× `500`. Depois: 1× `201` e 4× `409` |
| `backend/scripts/test-multi-tab-refresh.ts` (`npm run multi-tab:test`) | **Offline**: servidor simulado (uso único, reuso derruba a família) + cookie compartilhado + várias "abas" | 4 de 4: sem o lock, 2 abas derrubam a sessão (controle); com Web Locks, 2 e 5 abas renovam todas, com 1 requisição por aba |
| `backend/scripts/test-alerts.ts` (`npm run alerts:test`) | **Offline**: cada regra, repetição (cooldown e lembrete), "resolvido", formatos do webhook, falhas | 28 de 28 verificações passaram |
| `backend/scripts/test-alerts-live.js` | **Ao vivo**: receptor de webhook local, documentos reais parados e com erro no Supabase, queda e volta do Redis | 10 de 10: o alerta chega, não se repete no cooldown, o "resolvido" chega, o batimento da retenção é gravado e `/api/health/ready` responde 503 com o Redis fora e volta a 200 |
| `backend/scripts/test-resilient-throttler.ts` (`npm run throttler-resilient:test`) | **Offline**: rate limit com o Redis saudável, com erro, travado e voltando | 6 de 6 verificações passaram |
| `backend/scripts/test-redis-down-live.js` | **Ao vivo**: derruba o Redis com 3 réplicas no ar e testa login, `/api/health`, `/api/health/ready`, rotas autenticadas e o rate limit | 8 de 8: com o Redis parado, o login responde `401` em ~1 s (antes travava), `/api/health` responde `200` em ~10 ms, `/api/health/ready` responde `503`, uma rota autenticada responde `200` (o cache de termos cai para o banco) e o rate limit continua valendo por réplica (429 na 10ª tentativa com 3 réplicas); com o Redis de volta, tudo normaliza e o contador volta a ser gravado nele |
| `backend/scripts/test-uptime-check.js` (`npm run uptime:test`; com `LIVE=1` também contra o app real) | Monitor externo: servidor de saúde falso (200, 503, travado, porta fechada) e receptor de webhook; com `LIVE=1`, o `/api/health/ready` real com o Redis parado e religado | 13 de 13 offline; 16 de 16 com `LIVE=1`: um aviso por queda (sem repetir), "resolvido" na volta, oscilação de 2 falhas não alerta, travado estoura o timeout e não pendura, webhook fora não quebra |
| `backend/scripts/test-e2e-http.js` | Pela API HTTP: cadastro, termos, login, 8 uploads simultâneos, leitura do resultado — sempre alternando réplicas | Tudo passou; 8 documentos, cada um processado 1× |
| `backend/scripts/test-load-balancer.js` | Nginx: distribuição, contador, IP real e header forjado, upload grande, **dois dispositivos na mesma conta**, rate limit global, réplica morta, escala para 5 réplicas | 15 de 15 verificações passaram (distribuição 56/49/45; 0 falhas em 60 requisições com uma réplica morta; 5 réplicas usadas sem reiniciar o Nginx) |
| Carga na camada da fila (3.000 jobs, 30.000 enqueues, 3 workers em containers separados) | O comportamento do BullMQ sob volume | 3.000 execuções exatas com a fila pausada na rajada; 286 duplicados sem pausar (ver Etapa 4). **O script não ficou no repositório** |

```bash
# queue-race, double-stall e recovery-sweep rodam no host e precisam do Redis exposto
# (o override de teste também encurta a varredura periódica para 30 s):
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
cd backend
TS_NODE_FILES=true npx ts-node scripts/test-queue-race.ts            # N_DOCS=20 para o teste maior
TS_NODE_FILES=true npx ts-node scripts/test-queue-race.ts --kill     # derruba uma réplica no meio
TS_NODE_FILES=true npx ts-node scripts/test-double-stall.ts          # mata 2 réplicas (religa no fim)
TS_NODE_FILES=true npx ts-node scripts/test-recovery-sweep.ts        # varredura de documentos parados (intervalo de 30 s do override)
npm run status-retry:test                                             # offline, não precisa de Docker
npm run prod-checks:test                                              # offline, não precisa de Docker
npm run frontend-refresh:test                                         # offline, não precisa de Docker
npm run db-load:test                                                  # offline, não precisa de Docker
npm run multi-tab:test                                                # offline, não precisa de Docker
npm run alerts:test                                                   # offline, não precisa de Docker
npm run throttler-resilient:test                                      # offline, não precisa de Docker
npm run uptime:test                                                   # offline (LIVE=1 também contra o Compose de teste)
node backend/scripts/test-register-race.js                            # ao vivo; precisa do Nginx em :8080
node backend/scripts/test-alerts-live.js                              # ao vivo; precisa do Compose de teste (webhook em :9099)
node backend/scripts/test-redis-down-live.js                          # ao vivo; derruba e religa o Redis do Compose
node backend/scripts/test-db-load-live.js                             # ao vivo; precisa do Compose de teste (Redis em :6379)
node backend/scripts/test-refresh-race.js                             # ao vivo; precisa do Nginx em :8080 (LB_URL para mudar)
bash backend/scripts/test-redis-tls.sh                                # Docker + openssl; precisa de `npm run build` antes
cd ..
node backend/scripts/test-load-balancer.js                           # precisa do Nginx em :8080; leva alguns minutos
# e2e pela API, dentro da rede do Compose:
docker compose run --rm --no-deps -T -e NODE_PATH=/app/node_modules \
  -v "$PWD/backend/scripts:/t:ro" -v "$PWD/backend/test-fixtures:/fx:ro" \
  backend node /t/test-e2e-http.js
```

Todos usam o Supabase e o OpenRouter reais, criam um usuário de teste e **apagam
os dados que criaram**. Se um deles for interrompido no meio, a limpeza pode não
rodar: confira o Supabase por usuários `race-test+`, `stall-test+`, `sweep-test+`,
`e2e-http+` ou `lb-test+`.

### Limitações conhecidas

- **Documento parado se o banco estiver fora quando a análise falha** —
  *resolvido*. A falha de gravação do status tentava uma vez e só logava (visto
  durante uma queda de rede: 5 de 6 documentos ficaram em `processing`). Agora
  são 3 tentativas e, se todas falharem, a varredura periódica reenfileira o
  documento depois de `ANALYSIS_STUCK_TIMEOUT_MS`. **Resíduo:** nessa situação o
  usuário vê "processando" por até ~10 a 15 min (prazo de parado + intervalo da
  varredura) até o documento ser reanalisado automaticamente.
- A varredura reanalisa um documento parado do zero (chama a IA de novo). Se a
  análise já tinha sido gravada em `analyses` e só a gravação do `done` falhou,
  essa chamada é desperdiçada (o `upsert` mantém o resultado único).
- Concorrência do worker fixa em 2 por réplica.
- O volume de milhares de jobs foi testado só na camada da fila; o processador
  real com Supabase foi testado até 20 documentos (o OpenRouter gratuito não
  aguenta mais que isso). Queda de réplica testada com 1 e com 2 mortes
  seguidas, uma vez cada.
- Redis do Compose é **uma instância**, sem senha e sem réplica: serve para
  simular, não para produção.
- Pelo Docker Desktop (Mac), todo acesso do host aparece como `192.168.65.1`, então
  clientes locais dividem o mesmo limite de IP. Atrás de um load balancer de
  provedor o IP deve ser o real, mas isso só se confirma com deploy.
- `/api/debug/instance` é público e fora do rate limit quando ligado
  (`ENABLE_DEBUG_ENDPOINT=true`); fica desligado por padrão e a validação de
  produção avisa se estiver ligado.
- **Chamadas repetidas de `refresh` no frontend:** ao abrir uma página sem login, o
  navegador faz 4 chamadas a `POST /api/auth/refresh` (todas `401`, esperadas): o
  `reactStrictMode` do Next executa o efeito duas vezes em desenvolvimento e o cliente
  HTTP tenta o `refresh` de novo ao receber `401`. Em produção cai para metade, mas cada
  chamada conta no limite geral de 30 por minuto por IP dessa rota. Não foi alterado.
- O `next dev` (Next 16) gera `frontend/AGENTS.md` e `frontend/CLAUDE.md` ao iniciar;
  não fazem parte do projeto e não devem ser commitados.
- **Limite diário do plano gratuito do OpenRouter** (`free-models-per-day`): depois de algumas
  dezenas de análises no dia, as chamadas recebem `429` e todas as análises terminam em `error`
  ("Add 10 credits to unlock 1000 free model requests per day"). Aconteceu durante os testes. Em
  produção real é preciso um modelo pago ou créditos.
- Cerca de 1 em cada 10 análises do modelo gratuito termina em `error` por
  resposta fora do schema (falha da IA, não da fila).

### Preparação para produção (feita no repositório, sem criar nada na nuvem)

Arquitetura alvo de produção (o Redis é um serviço gerenciado, **fora** da VM, na mesma rede privada):

![Arquitetura de produção](docs/arquitetura-producao.svg)

O que o repositório já traz para ir a produção:

- **Validação de configuração no boot** (`src/config/production-checks.ts`, chamada
  em `main.ts` antes de abrir qualquer conexão). Só age com `NODE_ENV=production`.
  *Erros que abortam* (saída com código 1 e a lista de problemas): `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY` ou
  `OPENROUTER_API_KEY` ausentes; `REDIS_URL` ausente, inválida ou apontando para
  `localhost` (em produção não há Redis na própria máquina). *Avisos que não
  abortam:* Redis sem TLS (`redis://`) ou sem senha; `FRONTEND_URL` sem `https://`
  (o cookie `secure` do refresh token não é enviado por HTTP); `TRUST_PROXY` desligado;
  `ENABLE_DEBUG_ENDPOINT=true`; `ALERT_WEBHOOK_URL` ausente (os alertas ficariam só no log).
- **`backend/.env.production.example`**: modelo com todas as variáveis de produção
  (segredos como placeholders). Copie para `backend/.env.production` (ignorado pelo
  git) ou cadastre cada variável no painel do provedor.
- **`docker-compose.prod.yml`** — o que roda na VM, conforme o diagrama acima:
  - `nginx`: borda da VM, escuta 80 e 443, redireciona HTTP para HTTPS e reparte as
    requisições entre as réplicas (`nginx/nginx.prod.conf`, com o certificado em `./certs`).
    Por ser a borda, **sobrescreve** o `X-Forwarded-For` com o IP de quem conectou.
  - `backend`: N réplicas (`BACKEND_REPLICAS`, padrão 2), `TRUST_PROXY=true` e
    `ENABLE_DEBUG_ENDPOINT=false` fixos, healthcheck, limite de memória e CPU por réplica.
  - Os dois com `restart: unless-stopped`.
  - **Sem Redis no Compose**: o `REDIS_URL` do `.env.production` aponta para o serviço
    gerenciado. Se ele usar uma CA própria (não pública), descomente as 3 linhas indicadas
    no arquivo e coloque a CA em `./certs/redis-ca.pem`.
  - Suba com `docker compose -f docker-compose.prod.yml up -d --build`; faça o build **na VM**
    (uma imagem construída em um Mac com chip Apple é arm64 e não roda em uma VM x86).
- **Certificado do Nginx:** o compose espera `./certs/fullchain.pem` e `./certs/privkey.pem`
  (sem eles o Nginx não sobe). Quem emite é um passo à parte. Exemplo com Let's Encrypt,
  **não executado aqui** (precisa de um domínio público apontando para a VM), antes de subir o compose:
  `docker run --rm -p 80:80 -v "$PWD/le:/etc/letsencrypt" certbot/certbot certonly --standalone -d api.seudominio.com`,
  e copiar `le/live/api.seudominio.com/{fullchain,privkey}.pem` para `./certs/`. A renovação
  (a cada ~60 dias) precisa parar o Nginx por alguns segundos ou usar o modo `--webroot`.
- **`/api/debug` desligado por padrão** (404).
- **Redis com TLS e senha**: não foi preciso mudar código. O `ioredis` (e o BullMQ, que o
  usa) entende `rediss://usuario:senha@host:porta`. Com a CA do provedor pública não há
  nada a configurar; com uma CA própria, o Node precisa de `NODE_EXTRA_CA_CERTS`.
- **Política de memória do Redis**: o próprio BullMQ avisa no boot se não for `noeviction`
  (`IMPORTANT! Eviction policy is ...`).

**Como foi verificado** (tudo local, com certificados e containers descartáveis):
`npm run prod-checks:test` (17/17), `test-redis-tls.sh` (14/14) e a imagem de produção
rodando de verdade pelo `docker-compose.prod.yml` contra um Redis com TLS e senha:
saudável, processo como usuário `node`, `NODE_ENV=production`, **nenhum aviso de
configuração**, conectado ao Redis por TLS, `/api/health` = 200, `/api/debug/instance` =
404, rate limit funcionando e 16 chaves do BullMQ gravadas no Redis. Configuração quebrada
aborta com código 1 (sem as variáveis obrigatórias, e com `REDIS_URL` em `localhost`); configuração
só arriscada (Redis sem TLS/senha, `FRONTEND_URL` http, `TRUST_PROXY` off, debug ligado) apenas avisa.

**O compose de produção em si** (`docker-compose.prod.yml`, testado localmente com certificado
autoassinado e o Redis com TLS e senha, usando as instruções de CA privada do próprio arquivo):
HTTP responde `301` para HTTPS; HTTPS responde `200` com HTTP/2 e TLS 1.3; `/api/debug/instance` = `404`;
as 2 réplicas conectaram no Redis por TLS e subiram sem nenhum aviso de configuração; o rate limit
vale pelo HTTPS (5 respostas `401` e depois `429`); o IP gravado na auditoria é o de quem conectou e
**não** o do `X-Forwarded-For` forjado; um `SIGKILL` no processo `node` de uma réplica foi seguido de reinício
automático (`restart: unless-stopped`) e a réplica voltou saudável; `BACKEND_REPLICAS=3` escalou para 3
réplicas sem reiniciar o Nginx. Um detalhe do teste: `docker kill` conta como parada manual e **não**
dispara o reinício automático, então não serve para simular uma queda (o `SIGKILL` no processo, sim).

**O que NÃO foi verificado** (precisa de conta e infraestrutura reais):

- **A emissão real do certificado** (Let's Encrypt ou do provedor) e a renovação.
- O que acontece com o Nginx **sem** os certificados em `./certs` (pela documentação do Nginx, ele
  não sobe; não testei).

- Um **Redis gerenciado de verdade**. Só foi testado um Redis com TLS e senha local.
  Provedores variam: alguns restringem comandos administrativos (o aviso de eviction
  do BullMQ depende do `CONFIG GET`), têm limite de conexões e podem fechar conexões
  ociosas.
- **Load balancer, réplicas e HTTPS do provedor**, e o `TRUST_PROXY` com a topologia real
  (o `trust proxy 1` assume um único salto).
- Cookie `secure` por HTTPS no navegador (o teste de produção não passou por um
  frontend em HTTPS).

### Migrar para produção — passo a passo (NÃO feito)

O que o Supabase já é para o banco, o Redis precisa ser para a fila: um serviço
gerenciado, não um container.

1. **Redis gerenciado** (Upstash, Redis Cloud, ElastiCache, ou o Redis do próprio
   provedor de deploy): trocar só o `REDIS_URL` por `rediss://...`. Pontos a conferir:
   senha; persistência (AOF) ligada; `maxmemory-policy = noeviction` (o BullMQ exige,
   senão pode perder jobs por eviction); mesma região do backend; e o limite de
   conexões do plano — cada réplica abre várias (cliente compartilhado mais as conexões
   do BullMQ por fila e worker).
2. **Réplicas na VM:** use o `docker-compose.prod.yml` (acima): `.env.production` a partir do
   `.env.production.example` (**gere um par de chaves JWT novo**), certificado em `./certs`, e
   `docker compose -f docker-compose.prod.yml up -d --build` na própria VM. Alternativa: publicar
   a imagem em um registry e rodá-la direto no provedor, com as variáveis no painel.
3. **Mais de uma VM, ou um load balancer/CDN na frente do Nginx:** o `nginx.prod.conf` assume que
   ele é a borda e sobrescreve o `X-Forwarded-For`; com outro proxy na frente, ele passaria a
   registrar o IP desse proxy em vez do cliente. Nesse caso é preciso mudar o Nginx (confiar no
   cabeçalho do proxy conhecido, via `real_ip`) e conferir o número de saltos do `trust proxy`
   (hoje 1). O frontend e a API devem ficar sob o mesmo domínio raiz (o cookie do refresh token
   é `SameSite=strict`).
4. **`NODE_ENV=production` exige HTTPS:** o cookie do refresh token passa a ser
   `secure`. Localmente o container usa `NODE_ENV=development` (vem do `.env`).
5. **Antes de ir:** subir uma vez com a validação de produção (ela lista o que está
   errado), rever as limitações acima e alertar sobre jobs falhos e documentos
   parados em `processing`.
6. **Ligar o monitor externo:** definir `ALERT_WEBHOOK_URL` no `.env.production` e, no GitHub, a variável
   `HEALTH_URL` e o secret `ALERT_WEBHOOK_URL` (ver "Monitoramento e alertas"). Testar uma vez parando
   o Redis (ou apontando `HEALTH_URL` para um endereço errado) para ver o aviso chegar.

---

## Infraestrutura externa — o que este repo não inclui

Duas categorias bem diferentes: o que é **obrigatório pra qualquer coisa
funcionar** (Supabase e OpenRouter, seções 1 e 3, mais o Redis, que o backend
passou a exigir) e o que é **opcional** — código já escrito e referenciado
(env vars, clients), mas sem o serviço de verdade rodando em lugar nenhum
(ClamAV, `pg_cron`). Nenhum destes opcionais impede a aplicação de funcionar
hoje.

### Obrigatórios pra rodar

| Serviço | Pra que serve aqui | Onde configurar |
|---|---|---|
| **Supabase** (Postgres + Storage) | Banco de dados de toda a aplicação e armazenamento dos arquivos enviados | Seção 1 deste README |
| **OpenRouter** | Proxy de acesso ao modelo de IA que faz a análise de compliance (Fase 4) | Seção 3 deste README |
| **Redis** | Rate limit compartilhado (Fase 0), fila de análise do BullMQ (Fase 5) e job repetível da retenção de 72h (Fase 7). **Sem ele o backend não sobe** | `REDIS_URL` no `.env`. Local: sobe no `docker-compose.yml` (ou `docker run -p 6379:6379 redis:7-alpine` com o backend fora do Docker). Produção: Redis gerenciado — ver "Migrar para produção" na seção "Escalabilidade horizontal" |

### Opcionais e de infraestrutura

| Serviço | Pra que serve aqui | Onde está referenciado | Como ligar | Sem ele |
|---|---|---|---|---|
| **ClamAV** (`clamd`) | Scanner de vírus/malware por assinatura no upload de documentos (Fase 8) | `MalwareScanService` + `clamav.client.ts` (`src/documents/security/`), atrás de `ANTIVIRUS_ENABLED` | `docker run -p 3310:3310 clamav/clamav`, depois `ANTIVIRUS_ENABLED=true` + `CLAMAV_HOST`/`CLAMAV_PORT` no `.env` — é um switch, o código já fala o protocolo `INSTREAM` de verdade | Só a heurística estática de PDF roda (cobre os vetores mais comuns de PDF malicioso, mas não é um scanner de assinaturas) |
| **Reverse proxy / load balancer** | Distribuir requisições entre as réplicas e terminar HTTPS; pré-requisito pra `TRUST_PROXY=true` fazer sentido | Local: `nginx/nginx.conf` + serviço `nginx` do Compose (simulação, porta 8080). `TRUST_PROXY` em `configuration.ts`/`main.ts` | Local: `docker compose up -d --build`. Produção (VM): `nginx/nginx.prod.conf` com HTTPS, pelo `docker-compose.prod.yml`; um load balancer do provedor na frente exige mudar o Nginx (ver "Migrar para produção"); só ligue `TRUST_PROXY=true` depois de confirmar que existe um proxy de fato na frente | Sem proxy, `req.ip` usa o IP direto da conexão TCP — correto em dev local e em deploy sem proxy na frente |
| **Docker / Docker Compose** | Rodar Redis, as réplicas do backend e o Nginx juntos na máquina | `backend/Dockerfile`, `docker-compose.yml`, `docker-compose.test.yml` | Instalar o Docker Desktop; `docker compose up -d --build` | O backend roda com `npm run start:dev`, mas precisa de um Redis em `REDIS_URL` e só tem 1 instância |
| **`pg_cron`** (extensão nativa do Supabase) | Alternativa ao Redis pra agendar a retenção da Fase 7 **sem infraestrutura nova** — roda dentro do próprio Postgres do Supabase | Mencionado como opção na seção "Para escalar" da Fase 7 (a opção adotada foi o job repetível do BullMQ) | Habilitar a extensão no painel do Supabase e mover a lógica de `RetentionService.purgeExpired()` pra uma function SQL agendada | Não é necessária: a retenção já roda como job repetível do BullMQ |

> Em produção, vale também considerar um **secrets manager** do provedor de
> hospedagem (Vercel/Railway/Fly.io todos têm um) no lugar do `.env` em texto
> puro pras chaves JWT e demais segredos — comentado na seção 2, não é um
> serviço com protocolo próprio como os de cima, por isso não entrou na
> tabela.

---


## Notas de segurança já aplicadas

- Senhas com bcrypt (custo 12), nunca logadas.
- Refresh token guardado como hash SHA-256 no banco; rotação a cada uso;
  reuso de token revogado derruba toda a sessão do usuário.
- Access token de vida curta (15min), assinado com RS256 (chave privada só no
  backend).
- Upload valida o tipo real do arquivo pelos magic bytes, não pela extensão,
  e passa por verificação de malware (heurística de PDF sempre ativa + ClamAV
  plugável, Fase 8) antes de ser aceito.
- RLS habilitado em todas as tabelas (defesa em profundidade, mesmo o backend
  usando a `service_role` key).
- Rate limit dedicado (mais apertado que o geral) em login/registro e em
  upload — os dois endpoints mais expostos a abuso (brute-force e custo de
  Storage/IA, respectivamente).
- Logs de auditoria com IP do cliente, cobrindo login (inclusive tentativas
  com e-mail desconhecido), logout, reuso de refresh token, aceite de termo,
  upload e exclusão de documento.
- Headers HTTP explícitos (CSP, HSTS, `crossOriginResourcePolicy`) via
  Helmet, além do CORS restrito ao domínio do frontend.
- Acesso a documento de outro usuário responde `404`, não `403` — não revela
  nem que o documento existe.
- Resposta da IA nunca é confiada "cegamente" — sempre validada
  estruturalmente (schema Zod) antes de qualquer uso; JSON malformado ou fora
  do schema gera um erro claro (`InvalidAnalysisResponseError`) em vez de
  seguir adiante com dado ruim.
- Chamada à API de IA com timeout configurável e retry com backoff
  exponencial (não trava indefinidamente, não esgota tentativas em rajada).
- Arquivo original excluído automaticamente 72h após o upload (job agendado,
  Fase 7) ou antes disso por pedido do usuário — minimização de dados (LGPD,
  art. 6º, III); o resultado da análise em `analyses` não depende do arquivo
  original e não é afetado pela exclusão.
- Imagem Docker do backend sem segredos (`.env` e `*.pem` ficam no
  `.dockerignore`; tudo vem por variável de ambiente em runtime) e rodando como
  usuário sem privilégios (`node`).
- Atrás do Nginx, o `X-Forwarded-For` é **sobrescrito** com o IP de quem
  conectou, não acrescentado — o cliente não consegue forjar o IP usado pelo
  rate limit e pelos logs de auditoria (provado no teste do load balancer).
- Rate limit compartilhado no Redis: o limite vale somado entre todas as
  réplicas, então distribuir requisições entre instâncias não o contorna.

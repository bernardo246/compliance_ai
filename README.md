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
  hora; um worker in-process (sem Redis) baixa o arquivo do Storage, chama a
  IA, grava em `analyses` e move `documents.status` `uploaded` → `processing`
  → `done`/`error`. Endpoint `GET /api/analyses/:id`. Testável ponta a ponta
  via `npm run pipeline:test` (ver seção 5.1).
- **Fase 6** — Frontend de status e resultado: tela `/documentos/[id]` que faz
  polling do status (`uploaded`/`processing` → atualiza sozinha a cada 4s) e,
  quando `done`, renderiza o resultado completo (resumo executivo, checklist
  item a item com veredito/severidade/evidência/sugestão, dados faltantes,
  sugestões de melhoria, aviso legal). A lista em `/upload` também faz polling
  e cada item vira link para o resultado.
- **Fase 7** — Retenção de 72h: job agendado (`@nestjs/schedule`, a cada hora)
  varre `documents` com `expira_em` vencido, remove **só o arquivo original**
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
│   │   ├── documents/     # Fase 3 (upload) + retention.service.ts (Fase 7)
│   │   │   └── security/  # Fase 8 — malware-scan.service.ts, pdf-heuristics.ts, clamav.client.ts
│   │   └── analysis/      # Fase 4-5 — extração, runner, schema; prompts/ tem as 6 áreas (Fase 4 + 9)
│   ├── scripts/           # golden set (F4/F9) + pipeline (F5) + retenção (F7) + malware/segurança (F8)
│   ├── test-fixtures/     # 12 PDFs de teste (2 por área) com problemas conhecidos injetados
│   └── sql/               # 001_init + 002_analysis_pipeline + 003_retention.sql (rodar no Supabase, em ordem)
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
   `backend/sql/003_retention.sql` (índice usado pela varredura da Fase 7).
   Rodar **na ordem** (001 → 002 → 003). Todas são idempotentes
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
`AnalysisRunnerService.enqueue()` (o mesmo que o upload faz) e faz polling em
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

- `DocumentsService.upload()` chama `analysisRunner.enqueue(id)` **sem `await`**
  — a resposta do upload volta na hora com `status: 'uploaded'`.
- `AnalysisRunnerService` (`src/analysis/analysis-runner.service.ts`) tem uma
  fila em memória com concorrência `ANALYSIS_CONCURRENCY` (default 2). Cada job:
  baixa o arquivo do Storage → `AnalysisService.analyze()` → `upsert` em
  `analyses` (idempotente, `unique(document_id)`) → `status = 'done'`. Qualquer
  erro no caminho vira `status = 'error'` + `documents.erro` com a mensagem.
- No boot, `recoverPending()` reenfileira documentos que ficaram em `uploaded`
  (enqueue perdido num restart) ou `processing` há mais de
  `ANALYSIS_STUCK_TIMEOUT_MS` (processo caiu no meio de uma análise).
- `GET /api/analyses/:id` devolve o resultado (checagem de dono via join com
  `documents.user_id`). `GET /api/documents/:id` passa a incluir `analise`
  (ou `null`) — o frontend consulta status + resultado numa chamada só.

**Decisão de arquitetura — fila in-process vs. BullMQ + Redis**

A spec permite as duas (*"BullMQ/Redis **ou** processamento em background
simples"*). Optou-se pela fila in-process. Comparação:

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
  decorado com `@Cron(CronExpression.EVERY_HOUR)` — habilitado via
  `ScheduleModule.forRoot()` em `app.module.ts`.
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
| 0 — Infra | ⚠️ Quase | Rate limiter (`@nestjs/throttler`) usa contadores em RAM → mover para Redis |
| 1 — Auth | ✅ Sim | Nada (só as chaves RS256 idênticas em todas as instâncias) |
| 2 — Autorização / Termo | ✅ Sim | Nada |
| 3 — Upload | ✅ Sim | Nada (atenção operacional: Multer bufferiza em RAM) |
| 4 — IA (função isolada) | ✅ Sim | Nada no código (cuidado com o rate limit externo da OpenRouter) |
| 5 — Pipeline assíncrono | ❌ Não | Fila in-process → BullMQ + Redis |
| 6 — Frontend de status/resultado | ✅ Sim | Nada (frontend é stateless; atenção é ao **volume de polling** que ele gera no backend) |
| 7 — Retenção de 72h | ⚠️ Quase | `@Cron` roda por processo → com N instâncias, todas disparam a mesma varredura na mesma hora |
| 8 — Hardening de segurança | ✅ Sim | Nada de novo — herda a ressalva do rate limiter da Fase 0 (mesmo Redis resolve). ClamAV, se ligado, é um serviço externo compartilhado como o Supabase (todas as instâncias apontam pro mesmo `clamd`), não estado por instância |
| 9 — Expansão de templates | ✅ Sim | Nada — mesmo perfil da Fase 4 (templates são strings estáticas em código, zero estado, zero banco) |

**Conclusão:** adicionar **um único Redis** resolve a Fase 0 (rate limit
distribuído) e a Fase 5 (fila durável e compartilhada) de uma vez — e também
dá uma saída pronta para a Fase 7 (repeatable job do BullMQ roda uma vez só,
não por instância).

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

## Infraestrutura externa — o que este repo não inclui

Duas categorias bem diferentes: o que é **obrigatório pra qualquer coisa
funcionar** (já coberto nas seções 1 e 3 deste README) e o que é **opcional**
— código já escrito e referenciado (env vars, clients, comentários nas
tabelas de "como escalar" acima), mas sem o serviço de verdade rodando em
lugar nenhum. Nenhum destes opcionais impede a aplicação de funcionar hoje;
cada um resolve um problema específico que só aparece em cenários específicos
(produção com antivírus de verdade, múltiplas instâncias, etc.).

### Obrigatórios pra rodar

| Serviço | Pra que serve aqui | Onde configurar |
|---|---|---|
| **Supabase** (Postgres + Storage) | Banco de dados de toda a aplicação e armazenamento dos arquivos enviados | Seção 1 deste README |
| **OpenRouter** | Proxy de acesso ao modelo de IA que faz a análise de compliance (Fase 4) | Seção 3 deste README |

### Opcionais — referenciados no código, não inclusos

| Serviço | Pra que serve aqui | Onde está referenciado | Como ligar | Sem ele |
|---|---|---|---|---|
| **ClamAV** (`clamd`) | Scanner de vírus/malware por assinatura no upload de documentos (Fase 8) | `MalwareScanService` + `clamav.client.ts` (`src/documents/security/`), atrás de `ANTIVIRUS_ENABLED` | `docker run -p 3310:3310 clamav/clamav`, depois `ANTIVIRUS_ENABLED=true` + `CLAMAV_HOST`/`CLAMAV_PORT` no `.env` — é um switch, o código já fala o protocolo `INSTREAM` de verdade | Só a heurística estática de PDF roda (cobre os vetores mais comuns de PDF malicioso, mas não é um scanner de assinaturas) |
| **Redis** | Três usos distintos, todos hoje resolvidos sem ele: (1) storage compartilhado do rate limiter, pra N instâncias do backend dividirem o mesmo contador (Fase 0); (2) fila do BullMQ, no lugar do `AnalysisRunnerService` in-process (Fase 5); (3) *repeatable job* do BullMQ pra rodar a retenção de 72h uma vez só entre N instâncias (Fase 7) | Citado nas tabelas "como escalar" das Fases 0, 5 e 7 — **nenhuma linha de código depende dele hoje**, é só a direção de evolução já documentada | Não é um switch — cada um dos 3 usos é uma migração de código (trocar o storage do throttler; reescrever o runner pra `queue.add()`/`new Worker()`; trocar `@Cron` por um repeatable job) | Tudo funciona normalmente numa instância única — só vira necessário ao escalar horizontalmente |
| **Reverse proxy / load balancer** (Nginx, o proxy do provedor de deploy, etc.) | Terminar HTTPS e distribuir requisições entre instâncias em produção; é o pré-requisito pra `TRUST_PROXY=true` fazer sentido | `TRUST_PROXY` em `configuration.ts`/`main.ts` | Depende do provedor de hospedagem — só ligue `TRUST_PROXY=true` depois de confirmar que existe um proxy de fato na frente | `req.ip` usa o IP direto da conexão TCP — correto tanto em dev local quanto em deploy sem proxy na frente |
| **`pg_cron`** (extensão nativa do Supabase) | Alternativa ao Redis pra resolver a duplicação de execução do cron da Fase 7 (N instâncias rodando a mesma varredura) **sem precisar de infraestrutura nova** — roda dentro do próprio Postgres do Supabase | Mencionado como opção na seção "Para escalar" da Fase 7 | Habilitar a extensão no painel do Supabase e mover a lógica de `RetentionService.purgeExpired()` pra uma function SQL agendada | O `@Cron` in-process do NestJS cobre uma instância única sem problema |

> Em produção, vale também considerar um **secrets manager** do provedor de
> hospedagem (Vercel/Railway/Fly.io todos têm um) no lugar do `.env` em texto
> puro pras chaves JWT e demais segredos — comentado na seção 2, não é um
> serviço com protocolo próprio como os de cima, por isso não entrou na
> tabela.

---

## O que fica para as próximas fases

- **Fase 10** — Polimento e Deploy: deploy do backend (Railway/Render/Fly.io)
  e do frontend (Vercel), monitoramento básico (logs de erro, alertas de
  falha na API da IA), revisão final do Termo de Uso/Política de Privacidade
  com texto jurídico real, e testes de carga leve no fluxo de upload +
  análise. Última fase da spec — depois dela a aplicação está pronta pra uso
  real com dados de usuários reais.

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

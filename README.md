# Plataforma de Análise de Documentos e Dados com IA

Monorepo simples (duas pastas, dois `package.json`) cobrindo as **Fases 0 a 5**
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
│   │   ├── auth/          # Fase 1-2
│   │   ├── documents/     # Fase 3
│   │   └── analysis/      # Fase 4-5 — extração, prompt, OpenRouter, schema, runner
│   ├── scripts/           # golden set (Fase 4) + teste de pipeline (Fase 5)
│   ├── test-fixtures/     # PDFs de teste com problemas conhecidos injetados
│   └── sql/               # 001_init.sql + 002_analysis_pipeline.sql (rodar no Supabase, em ordem)
└── frontend/               # Next.js 16 (App Router)
    └── src/
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
   `documents.processing_started_at`, `documents.erro`, etc.). Rodar **depois**
   da 001. Ambas são idempotentes (`if not exists`), então rodar de novo não
   quebra nada.

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

## 5. Testando a Fase 4 isoladamente (golden set)

A integração com a IA pode ser testada sem precisar do frontend nem do fluxo
de upload completo — é assim que a Fase 4 foi validada durante o
desenvolvimento:

```bash
cd backend

# 1. Gera dois PDFs de teste em test-fixtures/: um contrato com 7 problemas
#    de compliance injetados de propósito, e um contrato bem estruturado.
npm run golden:build

# 2. Roda a análise de verdade contra os dois PDFs (usa sua OPENROUTER_API_KEY)
#    e confere quantos dos problemas conhecidos o modelo capturou.
npm run golden:test
```

O script imprime o `resumo_executivo`, o checklist completo item a item, e ao
final uma conferência automática de quantos dos problemas conhecidos
(ausência de CPF, reajuste sem índice, multa desproporcional, confidencialidade
sem prazo, ausência de assinatura/testemunhas) o modelo realmente encontrou.

Se algum problema esperado não for capturado consistentemente, é sinal de que
o prompt (`backend/src/analysis/prompts/juridico.prompt.ts`) precisa de ajuste
— é exatamente para isso que serve o golden set.

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

Limitação assumida (a spec permite "background simples" no lugar de BullMQ +
Redis): a fila vive no processo. Uma instância única do backend está coberta
pela recuperação no boot; para múltiplas instâncias / worker separado, trocar
`AnalysisRunnerService` por BullMQ é uma mudança localizada.

## 6. Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
# App em http://localhost:3000
```

## Fluxo esperado (Fases 0-3, via frontend)

1. `/register` → cria conta → redireciona para `/termos`.
2. `/termos` → aceite obrigatório → redireciona para `/upload`.
3. `/upload` → escolhe área de negócio, envia PDF/CSV/XLSX → lista os
   documentos do usuário com status.

Sem aceitar o termo, `/api/documents/*` responde `403 Forbidden`
(`TermsAcceptedGuard`) mesmo com um access token válido.

Desde a **Fase 5**, o upload já dispara a análise automaticamente: o documento
entra como `uploaded` e o worker in-process move para `processing` e depois
`done`/`error`. O que ainda falta é o **frontend** de status/polling e de
resultado — hoje o `/upload` só mostra o rótulo de status, sem tela de
resultado. Isso é a Fase 6.

## O que fica para as próximas fases

- **Fase 6** — Telas de status/polling e resultado (resumo executivo,
  compliance, sugestões) no frontend.
- **Fase 7** — Job agendado de retenção de 72h (deleção automática do arquivo
  original do Storage).
- **Fase 8** — Hardening de segurança (scan antivírus no upload, revisão
  completa do checklist de segurança).
- **Fase 9** — Templates de prompt para as demais áreas (`financas`,
  `imobiliario`, `rh`, `saude`, `outro`) — hoje só `juridico` está implementado.

## Notas de segurança já aplicadas

- Senhas com bcrypt (custo 12), nunca logadas.
- Refresh token guardado como hash SHA-256 no banco; rotação a cada uso;
  reuso de token revogado derruba toda a sessão do usuário.
- Access token de vida curta (15min), assinado com RS256 (chave privada só no
  backend).
- Upload valida o tipo real do arquivo pelos magic bytes, não pela extensão.
- RLS habilitado em todas as tabelas (defesa em profundidade, mesmo o backend
  usando a `service_role` key).
- Resposta da IA nunca é confiada "cegamente" — sempre validada
  estruturalmente (schema Zod) antes de qualquer uso; JSON malformado ou fora
  do schema gera um erro claro (`InvalidAnalysisResponseError`) em vez de
  seguir adiante com dado ruim.
- Chamada à API de IA com timeout configurável e retry com backoff
  exponencial (não trava indefinidamente, não esgota tentativas em rajada).

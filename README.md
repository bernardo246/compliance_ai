# Plataforma de Análise de Documentos e Dados com IA

Monorepo simples (duas pastas, dois `package.json`) cobrindo as **Fases 0 a 3**
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

O visual do frontend segue à risca o `design-system.md` (paleta escura +
verde, glassmorphism, grid de fundo, glow, tipografia).

**Versões:** Node.js 22+ (testado com Node 24), NestJS 11.x, Next.js 16.x +
React 19. Todas as dependências foram checadas contra `npm audit` — zero
vulnerabilidades conhecidas na árvore de dependências no momento da entrega.

## Estrutura

```
projeto-analise-ia/
├── backend/     # NestJS
│   ├── src/
│   └── sql/001_init.sql   # rodar no SQL editor do Supabase
└── frontend/    # Next.js 15 (App Router)
    └── src/
```

## Pré-requisitos

- Node.js 22+ (testado com Node 24)
- Uma conta/projeto no [Supabase](https://supabase.com) (Postgres + Storage)
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

### 1.2. Rodar a migration (criar as tabelas)

1. No painel do projeto, vá em **SQL Editor** (ícone de terminal na sidebar).
2. Clique em **New query**.
3. Abra o arquivo `backend/sql/001_init.sql` deste projeto, copie todo o
   conteúdo e cole no editor.
4. Clique em **Run** (ou `Ctrl+Enter`).
5. Confirme em **Table Editor** que as tabelas apareceram: `users`,
   `refresh_tokens`, `documents`, `analyses`, `audit_logs`.

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

### 2.3. Depois de configurado

Não precisa fazer mais nada manualmente — o `AuthService` usa
`JWT_PRIVATE_KEY` para assinar o access token (RS256, expira em 15min por
padrão) e o `JwtStrategy` usa `JWT_PUBLIC_KEY` para validar cada request.

## 3. Backend

```bash
cd backend
npm install
cp .env.example .env
# preencha SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e as chaves JWT (passos 1 e 2 acima)

npm run start:dev
# API em http://localhost:3001
```

Teste rápido:

```bash
curl http://localhost:3001/api/health
```

## 4. Frontend

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
# App em http://localhost:3000
```


## Fluxo esperado

1. `/register` → cria conta → redireciona para `/termos`.
2. `/termos` → aceite obrigatório → redireciona para `/upload`.
3. `/upload` → escolhe área de negócio, envia PDF/CSV/XLSX → lista os
   documentos do usuário com status.

Sem aceitar o termo, `/api/documents/*` responde `403 Forbidden`
(`TermsAcceptedGuard`) mesmo com um access token válido.

## O que fica para as próximas fases (não incluído aqui)

- **Fase 4** — Extração de conteúdo (parsing de PDF/CSV/XLSX).
- **Fase 5** — Pipeline de análise via Claude API + fila/worker assíncrono,
  preenchendo a tabela `analyses` (já criada na migração).
- **Fase 6** — Telas de status/polling e resultado (resumo executivo,
  compliance, sugestões) no frontend.
- **Fase 7/8** — Relatórios exportáveis, hardening (antivírus no upload, testes
  automatizados, observabilidade).

## Notas de segurança já aplicadas

- Senhas com bcrypt (custo 12), nunca logadas.
- Refresh token guardado como hash SHA-256 no banco; rotação a cada uso;
  reuso de token revogado derruba toda a sessão do usuário.
- Access token de vida curta (15min), assinado com RS256 (chave privada só no
  backend).
- Upload valida o tipo real do arquivo pelos magic bytes, não pela extensão.
- RLS habilitado em todas as tabelas (defesa em profundidade, mesmo o backend
  usando a `service_role` key).

-- ============================================================================
-- Migração 001 — Fundamentos, Auth, Termo de Uso, Documentos (Fases 0-3)
-- Rodar no SQL Editor do Supabase (ou via CLI: supabase db push)
-- ============================================================================

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- users
-- Autenticação é feita no backend (bcrypt + JWT), não via Supabase Auth,
-- então esta tabela guarda o hash de senha diretamente.
-- ---------------------------------------------------------------------------
create table if not exists users (
  id uuid primary key default uuid_generate_v4(),
  email text not null unique,
  password_hash text not null,
  role text not null default 'user' check (role in ('user', 'admin')),
  terms_accepted boolean not null default false,
  terms_version text,
  terms_accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_users_email on users (email);

-- ---------------------------------------------------------------------------
-- refresh_tokens
-- Suporta rotação de refresh token e revogação (logout / detecção de reuso).
-- Guardamos apenas o hash SHA-256 do token, nunca o valor em claro.
-- ---------------------------------------------------------------------------
create table if not exists refresh_tokens (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users (id) on delete cascade,
  token_hash text not null unique,
  revoked boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_refresh_tokens_user on refresh_tokens (user_id);
create index if not exists idx_refresh_tokens_hash on refresh_tokens (token_hash);

-- ---------------------------------------------------------------------------
-- documents
-- ---------------------------------------------------------------------------
create table if not exists documents (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references users (id) on delete cascade,
  tipo text not null check (tipo in ('pdf', 'csv', 'xlsx')),
  area_negocio text not null check (
    area_negocio in ('financas', 'juridico', 'imobiliario', 'rh', 'saude', 'outro')
  ),
  nome_original text not null,
  storage_path text,
  status text not null default 'uploaded' check (
    status in ('uploaded', 'processing', 'done', 'error')
  ),
  expira_em timestamptz not null,
  deletado_em timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_documents_user on documents (user_id);
create index if not exists idx_documents_status on documents (status);

-- ---------------------------------------------------------------------------
-- analyses — preparado para a Fase 4/5 (pipeline de IA), já modelado agora
-- para não quebrar o schema depois.
-- ---------------------------------------------------------------------------
create table if not exists analyses (
  id uuid primary key default uuid_generate_v4(),
  document_id uuid not null references documents (id) on delete cascade,
  resumo_executivo text,
  compliance jsonb,
  sugestoes_melhoria jsonb,
  modelo_usado text,
  tokens_usados integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_analyses_document on analyses (document_id);

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------
create table if not exists audit_logs (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references users (id) on delete set null,
  acao text not null,
  ip_address text,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_user on audit_logs (user_id);

-- ============================================================================
-- Row Level Security
-- O backend usa a service_role key (bypassa RLS) porque a autorização é
-- decidida em código (guards). O RLS abaixo é a segunda camada de defesa:
-- protege os dados caso algo acesse o Postgres diretamente com uma chave
-- anon/authenticated no futuro (ex.: se o frontend passar a falar direto
-- com o Supabase para leitura).
-- ============================================================================

alter table users enable row level security;
alter table refresh_tokens enable row level security;
alter table documents enable row level security;
alter table analyses enable row level security;
alter table audit_logs enable row level security;

-- Nenhuma policy "anon"/"authenticated" é criada aqui de propósito: por
-- padrão, com RLS ligado e sem policies, ninguém além da service_role
-- consegue ler/escrever. Adicione policies pontuais se o frontend passar
-- a consultar o Supabase diretamente.

-- ============================================================================
-- Migração 002 — Pipeline Assíncrono e Persistência do Resultado (Fase 5)
-- Rodar no SQL Editor do Supabase DEPOIS da 001.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- analyses — a 001 criou a tabela com um shape mínimo ("preparado para a
-- Fase 4/5"). Aqui ela ganha as colunas que espelham o AnalysisResult
-- validado pelo Zod (backend/src/analysis/schemas/analysis-result.schema.ts).
--
-- `compliance` (jsonb genérico da 001) é substituída por `checklist`, com o
-- mesmo conteúdo mas nome que casa com o schema. A tabela está vazia neste
-- ponto do projeto, então o drop é seguro.
-- ---------------------------------------------------------------------------
alter table analyses drop column if exists compliance;

alter table analyses
  add column if not exists status_compliance_geral text
    check (
      status_compliance_geral in
      ('conforme', 'nao_conforme', 'parcial', 'nao_verificavel')
    ),
  add column if not exists checklist jsonb,
  add column if not exists dados_faltantes jsonb,
  add column if not exists aviso_legal text,
  add column if not exists template_versao text,
  -- Resposta bruta do modelo, para auditoria/debug (spec seção 5:
  -- `raw_claude_response`). Guardada como texto dentro de um jsonb simples
  -- ({ "raw": "..." }) porque nem sempre é JSON parseável.
  add column if not exists raw_response jsonb;

-- Uma análise por documento. O runner usa upsert com este alvo de conflito
-- para ser idempotente (reprocessar um documento não cria linha duplicada).
alter table analyses drop constraint if exists analyses_document_unique;
alter table analyses add constraint analyses_document_unique unique (document_id);

-- ---------------------------------------------------------------------------
-- documents — suporte ao ciclo de vida da análise assíncrona.
-- ---------------------------------------------------------------------------
alter table documents
  -- Quando a análise entrou em 'processing'. Usado pela recuperação de
  -- documentos travados: se o processo caiu no meio de uma análise, o doc
  -- fica 'processing' para sempre — no boot seguinte, docs 'processing' há
  -- mais de ANALYSIS_STUCK_TIMEOUT_MS são reenfileirados.
  add column if not exists processing_started_at timestamptz,
  -- Mensagem de erro quando status = 'error', para o usuário/frontend saber
  -- o que aconteceu (ex.: "PDF sem camada de texto", "IA indisponível").
  add column if not exists erro text;

-- Índice parcial: a recuperação no boot varre só o que está pendente.
create index if not exists idx_documents_pendentes
  on documents (status)
  where status in ('uploaded', 'processing');

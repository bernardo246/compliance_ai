-- ============================================================================
-- Migração 003 — Retenção de 72h (Fase 7)
-- Rodar no SQL Editor do Supabase DEPOIS da 002.
-- ============================================================================

-- Nenhuma coluna nova: `documents` já tem `storage_path`, `expira_em` e
-- `deletado_em` desde a 001 — a Fase 7 só passou a lê-las/escrevê-las
-- automaticamente via cron (RetentionService), em vez de só na exclusão
-- manual (DELETE /api/documents/:id).
--
-- Único acréscimo: um índice parcial para a varredura horária
-- (`documents.expira_em` filtrado por `deletado_em is null`), já que o job
-- roda a cada hora e não deveria custar um full scan da tabela conforme ela
-- cresce.
create index if not exists idx_documents_retencao
  on documents (expira_em)
  where deletado_em is null;

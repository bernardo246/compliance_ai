-- 005 — índices para a retenção de audit_logs e de analyses.raw_response (retention.service.ts).
-- Rodar no SQL Editor do Supabase, depois da 004. Idempotente.

-- apagar registros de auditoria antigos (AUDIT_LOG_RETENTION_DAYS)
create index if not exists idx_audit_logs_created_at on audit_logs (created_at);

-- zerar raw_response das análises antigas (RAW_RESPONSE_RETENTION_DAYS): índice parcial, só das
-- linhas que ainda têm a resposta bruta (ele encolhe sozinho conforme a limpeza avança)
create index if not exists idx_analyses_raw_response_antigas
  on analyses (created_at) where raw_response is not null;

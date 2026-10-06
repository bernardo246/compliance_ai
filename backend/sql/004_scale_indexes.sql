-- 004 — índices para a limpeza de refresh tokens e para os alertas de monitoramento.
-- Rodar no SQL Editor do Supabase, depois da 003. Idempotente.

-- limpeza de refresh tokens expirados (retention.service.ts)
create index if not exists idx_refresh_tokens_expires on refresh_tokens (expires_at);

-- limpeza de refresh tokens revogados antigos: índice parcial, só das linhas revogadas
create index if not exists idx_refresh_tokens_revogados_antigos
  on refresh_tokens (created_at) where revoked = true;

-- alertas: documentos criados na janela recente (taxa de erro da análise)
create index if not exists idx_documents_created_at on documents (created_at);

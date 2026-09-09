import { z } from 'zod';

/**
 * Schema do JSON que o Claude deve retornar, conforme seção 6.2 da spec:
 * formato rígido, cada item do checklist com veredito de compliance,
 * referência normativa, severidade e evidência — nunca "certo/errado" solto.
 *
 * `nullable()` é usado (em vez de `.optional()`) nos campos que podem faltar
 * porque queremos que o modelo seja OBRIGADO a se pronunciar sobre eles como
 * `null` explicitamente, em vez de simplesmente omitir a chave — reduz a
 * chance de omissão silenciosa por parte do modelo.
 */

export const StatusComplianceItem = z.enum(['conforme', 'nao_conforme', 'nao_verificavel']);

export const StatusComplianceGeral = z.enum([
  'conforme',
  'nao_conforme',
  'parcial',
  'nao_verificavel',
]);

export const Severidade = z.enum(['baixa', 'media', 'alta', 'critica']);

export const ChecklistItemSchema = z.object({
  item: z.string().min(1),
  status_compliance: StatusComplianceItem,
  referencia_normativa: z.string().nullable(),
  severidade: Severidade,
  evidencia: z.string().nullable(),
  sugestao_correcao: z.string().nullable(),
});

export const AnalysisResultSchema = z.object({
  resumo_executivo: z.string().min(1),
  status_compliance_geral: StatusComplianceGeral,
  checklist: z.array(ChecklistItemSchema).min(1),
  dados_faltantes: z.array(z.string()),
  // Requisito central do produto (seção 6, item 7) — sempre obrigatório,
  // mesmo que vazio (nunca ausente).
  sugestoes_melhoria: z.array(z.string()),
  aviso_legal: z.string().min(1),
});

export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

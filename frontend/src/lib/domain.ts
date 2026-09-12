/**
 * Tipos e rótulos compartilhados entre a tela de upload e a tela de
 * detalhe/resultado (Fase 6) — espelham os enums do backend
 * (`documents.types.ts`, `analysis-result.schema.ts`) para não duplicar
 * essa lista em cada página.
 */

export const AREAS = [
  { value: 'financas', label: 'Finanças' },
  { value: 'juridico', label: 'Jurídico' },
  { value: 'imobiliario', label: 'Imobiliário' },
  { value: 'rh', label: 'Recursos Humanos' },
  { value: 'saude', label: 'Saúde' },
  { value: 'outro', label: 'Outro' },
] as const;

export type AreaNegocio = (typeof AREAS)[number]['value'];

export function areaLabel(area: string): string {
  return AREAS.find((a) => a.value === area)?.label ?? area;
}

export type DocumentStatus = 'uploaded' | 'processing' | 'done' | 'error';

export const STATUS_LABEL: Record<DocumentStatus, string> = {
  uploaded: 'Enviado',
  processing: 'Processando',
  done: 'Concluído',
  error: 'Erro',
};

/** Status ainda não chegou num estado final — a tela deve continuar o polling. */
export function isPendingStatus(status: DocumentStatus): boolean {
  return status === 'uploaded' || status === 'processing';
}

export interface DocumentItem {
  id: string;
  nome_original: string;
  tipo: string;
  area_negocio: string;
  status: DocumentStatus;
  created_at: string;
  expira_em?: string;
}

export type StatusComplianceGeral = 'conforme' | 'nao_conforme' | 'parcial' | 'nao_verificavel';
export type StatusComplianceItem = 'conforme' | 'nao_conforme' | 'nao_verificavel';
export type Severidade = 'baixa' | 'media' | 'alta' | 'critica';

export const STATUS_COMPLIANCE_LABEL: Record<StatusComplianceGeral, string> = {
  conforme: 'Conforme',
  nao_conforme: 'Não conforme',
  parcial: 'Parcialmente conforme',
  nao_verificavel: 'Não verificável',
};

export const SEVERIDADE_LABEL: Record<Severidade, string> = {
  baixa: 'Baixa',
  media: 'Média',
  alta: 'Alta',
  critica: 'Crítica',
};

/** Classes Tailwind de badge por veredito de compliance (geral ou por item). */
export function statusComplianceClasses(status: StatusComplianceGeral | StatusComplianceItem): string {
  switch (status) {
    case 'conforme':
      return 'border-brand/30 bg-brand/10 text-brand';
    case 'nao_conforme':
      return 'border-red-500/30 bg-red-500/10 text-red-400';
    case 'parcial':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
    case 'nao_verificavel':
      return 'border-borderSoft bg-white/5 text-textSecondary';
  }
}

/** Classes Tailwind de badge por severidade do item do checklist. */
export function severidadeClasses(severidade: Severidade): string {
  switch (severidade) {
    case 'critica':
      return 'border-red-500/30 bg-red-500/10 text-red-400';
    case 'alta':
      return 'border-orange-500/30 bg-orange-500/10 text-orange-400';
    case 'media':
      return 'border-amber-500/30 bg-amber-500/10 text-amber-400';
    case 'baixa':
      return 'border-borderSoft bg-white/5 text-textSecondary';
  }
}

export interface ChecklistItem {
  item: string;
  status_compliance: StatusComplianceItem;
  referencia_normativa: string | null;
  severidade: Severidade;
  evidencia: string | null;
  sugestao_correcao: string | null;
}

export interface Analise {
  id: string;
  resumo_executivo: string;
  status_compliance_geral: StatusComplianceGeral;
  checklist: ChecklistItem[];
  dados_faltantes: string[];
  sugestoes_melhoria: string[];
  aviso_legal: string;
  modelo_usado: string | null;
  template_versao: string | null;
  created_at: string;
}

export interface DocumentDetail extends DocumentItem {
  erro: string | null;
  analise: Analise | null;
}

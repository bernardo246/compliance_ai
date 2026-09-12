import { AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { DocumentStatus, STATUS_LABEL } from '@/lib/domain';

/** Badge de status do documento (uploaded/processing/done/error) — Fase 6. */
export function StatusBadge({ status }: { status: DocumentStatus }) {
  const base = 'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs';

  if (status === 'done') {
    return (
      <span className={`${base} border-brand/30 bg-brand/10 text-brand`}>
        <CheckCircle2 className="h-3 w-3" aria-hidden />
        {STATUS_LABEL[status]}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className={`${base} border-red-500/30 bg-red-500/10 text-red-400`}>
        <AlertCircle className="h-3 w-3" aria-hidden />
        {STATUS_LABEL[status]}
      </span>
    );
  }
  return (
    <span className={`${base} border-borderSoft text-textSecondary`}>
      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

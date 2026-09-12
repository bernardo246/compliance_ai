'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, ArrowLeft, FileText, Loader2, ShieldAlert, Sparkles } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { apiJson } from '@/lib/api';
import { Navbar } from '@/components/Navbar';
import { StatusBadge } from '@/components/StatusBadge';
import {
  areaLabel,
  DocumentDetail,
  isPendingStatus,
  SEVERIDADE_LABEL,
  severidadeClasses,
  STATUS_COMPLIANCE_LABEL,
  statusComplianceClasses,
} from '@/lib/domain';

// Mesmo intervalo do /upload — repolla enquanto o worker (Fase 5) não
// terminar. É o "tela de status/polling" pedido no critério de pronto da
// Fase 6.
const POLL_INTERVAL_MS = 4000;

export default function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user, loading } = useAuth();
  const router = useRouter();

  const [doc, setDoc] = useState<DocumentDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [loadingDoc, setLoadingDoc] = useState(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!loading) {
      if (!user) router.replace('/login');
      else if (!user.terms_accepted) router.replace('/termos');
    }
  }, [user, loading, router]);

  const load = useCallback(async () => {
    try {
      // GET /api/documents/:id já embute a análise (Fase 5) — uma chamada só
      // dá status + resultado.
      const data = await apiJson<DocumentDetail>(`/api/documents/${id}`);
      setDoc(data);
    } catch {
      setNotFound(true);
    } finally {
      setLoadingDoc(false);
    }
  }, [id]);

  useEffect(() => {
    if (!user?.terms_accepted) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount é o padrão canônico aqui (mesmo do /upload); load() só seta estado após a resposta assíncrona da API.
    void load();
  }, [user, load]);

  useEffect(() => {
    if (!doc || !isPendingStatus(doc.status)) return;
    pollRef.current = setTimeout(() => void load(), POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [doc, load]);

  return (
    <>
      <Navbar />
      <main className="section-container">
        <Link
          href="/upload"
          className="focus-ring inline-flex items-center gap-1.5 text-sm text-textSecondary transition hover:text-brand"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Voltar para meus documentos
        </Link>

        {loadingDoc && (
          <div className="mt-10 flex items-center gap-2 text-sm text-textSecondary">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Carregando...
          </div>
        )}

        {!loadingDoc && notFound && (
          <div className="glass-card mt-10 rounded-3xl p-8 text-center">
            <p className="text-textSecondary">
              Documento não encontrado (ou não pertence à sua conta).
            </p>
          </div>
        )}

        {!loadingDoc && doc && (
          <>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <FileText className="h-6 w-6 text-brand" aria-hidden />
                <div>
                  <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
                    {doc.nome_original}
                  </h1>
                  <p className="text-sm text-textSecondary">
                    {areaLabel(doc.area_negocio)} · {doc.tipo.toUpperCase()} ·{' '}
                    {new Date(doc.created_at).toLocaleString('pt-BR')}
                  </p>
                </div>
              </div>
              <StatusBadge status={doc.status} />
            </div>

            {isPendingStatus(doc.status) && (
              <div className="glass-card mt-10 flex flex-col items-center gap-3 rounded-3xl p-12 text-center">
                <Loader2 className="h-8 w-8 animate-spin text-brand" aria-hidden />
                <p className="font-medium">Estamos analisando o seu documento...</p>
                <p className="max-w-md text-sm text-textSecondary">
                  A análise por IA pode levar de alguns segundos a alguns minutos,
                  dependendo do tamanho do documento. Esta página atualiza sozinha —
                  não precisa recarregar.
                </p>
              </div>
            )}

            {doc.status === 'error' && (
              <div className="glass-card mt-10 rounded-3xl border-red-500/30 bg-red-500/5 p-8">
                <div className="flex items-center gap-2 text-red-400">
                  <ShieldAlert className="h-5 w-5" aria-hidden />
                  <h2 className="text-lg font-semibold">Não foi possível concluir a análise</h2>
                </div>
                <p className="mt-3 text-sm text-textSecondary">
                  {doc.erro ?? 'Ocorreu um erro inesperado ao analisar este documento.'}
                </p>
                <p className="mt-3 text-sm text-textSecondary">
                  Você pode enviar o documento novamente — cada envio gera uma análise nova.
                </p>
              </div>
            )}

            {doc.status === 'done' && doc.analise && <AnaliseResultado analise={doc.analise} />}
          </>
        )}
      </main>
    </>
  );
}

function AnaliseResultado({ analise }: { analise: NonNullable<DocumentDetail['analise']> }) {
  return (
    <div className="mt-10 space-y-8">
      <section className="glass-card rounded-3xl p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Resumo executivo</h2>
          <span
            className={`rounded-full border px-3 py-1 text-xs font-medium ${statusComplianceClasses(analise.status_compliance_geral)}`}
          >
            {STATUS_COMPLIANCE_LABEL[analise.status_compliance_geral]}
          </span>
        </div>
        <p className="mt-4 leading-relaxed text-textSecondary">{analise.resumo_executivo}</p>
      </section>

      <section className="glass-card rounded-3xl p-8">
        <h2 className="text-lg font-semibold">
          Checklist de compliance{' '}
          <span className="text-sm font-normal text-textSecondary">
            ({analise.checklist.length} itens)
          </span>
        </h2>
        <ul className="mt-6 space-y-4">
          {analise.checklist.map((item, i) => (
            <li key={i} className="rounded-2xl border border-borderSoft bg-white/5 p-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="font-medium">{item.item}</p>
                <div className="flex flex-wrap gap-2">
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${statusComplianceClasses(item.status_compliance)}`}
                  >
                    {STATUS_COMPLIANCE_LABEL[item.status_compliance]}
                  </span>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs ${severidadeClasses(item.severidade)}`}
                  >
                    Severidade: {SEVERIDADE_LABEL[item.severidade]}
                  </span>
                </div>
              </div>

              {item.referencia_normativa && (
                <p className="mt-2 text-xs text-textSecondary">
                  Referência: {item.referencia_normativa}
                </p>
              )}
              {item.evidencia && (
                <blockquote className="mt-3 border-l-2 border-borderSoft pl-3 text-sm italic text-textSecondary">
                  “{item.evidencia}”
                </blockquote>
              )}
              {item.sugestao_correcao && (
                <p className="mt-3 flex gap-2 text-sm">
                  <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" aria-hidden />
                  <span>{item.sugestao_correcao}</span>
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {analise.dados_faltantes.length > 0 && (
        <section className="glass-card rounded-3xl p-8">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <AlertTriangle className="h-5 w-5 text-amber-400" aria-hidden />
            Dados faltantes
          </h2>
          <ul className="mt-4 list-inside list-disc space-y-1.5 text-sm text-textSecondary">
            {analise.dados_faltantes.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </section>
      )}

      <section className="glass-card rounded-3xl p-8">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Sparkles className="h-5 w-5 text-brand" aria-hidden />
          Sugestões de melhoria
        </h2>
        {analise.sugestoes_melhoria.length > 0 ? (
          <ol className="mt-4 list-inside list-decimal space-y-1.5 text-sm text-textSecondary">
            {analise.sugestoes_melhoria.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        ) : (
          <p className="mt-4 text-sm text-textSecondary">Nenhuma sugestão adicional.</p>
        )}
      </section>

      <p className="rounded-xl border border-borderSoft bg-white/5 px-4 py-3 text-xs leading-relaxed text-textSecondary">
        {analise.aviso_legal}
      </p>

      <p className="text-xs text-textSecondary/70">
        Modelo: {analise.modelo_usado ?? '—'} · Template: {analise.template_versao ?? '—'}
      </p>
    </div>
  );
}

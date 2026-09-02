'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileText, Loader2, UploadCloud } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { apiFetch, apiJson } from '@/lib/api';
import { Navbar } from '@/components/Navbar';

const AREAS = [
  { value: 'financas', label: 'Finanças' },
  { value: 'juridico', label: 'Jurídico' },
  { value: 'imobiliario', label: 'Imobiliário' },
  { value: 'rh', label: 'Recursos Humanos' },
  { value: 'saude', label: 'Saúde' },
  { value: 'outro', label: 'Outro' },
] as const;

interface DocumentItem {
  id: string;
  nome_original: string;
  tipo: string;
  area_negocio: string;
  status: 'uploaded' | 'processing' | 'done' | 'error';
  created_at: string;
}

const STATUS_LABEL: Record<DocumentItem['status'], string> = {
  uploaded: 'Enviado',
  processing: 'Processando',
  done: 'Concluído',
  error: 'Erro',
};

export default function UploadPage() {
  const { user, loading } = useAuth();
  const router = useRouter();

  const [area, setArea] = useState<(typeof AREAS)[number]['value']>('financas');
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [loadingDocs, setLoadingDocs] = useState(true);

  useEffect(() => {
    if (!loading) {
      if (!user) router.replace('/login');
      else if (!user.terms_accepted) router.replace('/termos');
    }
  }, [user, loading, router]);

  const loadDocuments = useCallback(async () => {
    try {
      const data = await apiJson<DocumentItem[]>('/api/documents');
      setDocuments(data);
    } catch {
      // silencioso — a lista é secundária à ação de upload
    } finally {
      setLoadingDocs(false);
    }
  }, []);

  useEffect(() => {
    if (!user?.terms_accepted) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-on-mount é o padrão canônico aqui; loadDocuments só seta estado após a resposta da API (assíncrono).
    void loadDocuments();
  }, [user, loadDocuments]);

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped) setFile(dropped);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!file) {
      setError('Selecione um arquivo (PDF, CSV ou XLSX).');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('area_negocio', area);

    setSubmitting(true);
    try {
      const res = await apiFetch('/api/documents', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? 'Falha ao enviar o documento.');
      }
      setFile(null);
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao enviar o documento.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Navbar />
      <main className="section-container">
        <h1 className="section-title">Enviar documento para análise</h1>
        <p className="mt-2 max-w-2xl text-textSecondary">
          Escolha a área de negócio e envie um arquivo PDF, CSV ou XLSX (até 20MB). O
          documento é excluído automaticamente após 72 horas.
        </p>

        <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_1fr]">
          <form onSubmit={handleSubmit} className="glass-card space-y-6 rounded-3xl p-8">
            <div>
              <label htmlFor="area" className="mb-1.5 block text-sm text-textSecondary">
                Área de negócio
              </label>
              <select
                id="area"
                value={area}
                onChange={(e) => setArea(e.target.value as typeof area)}
                className="input-field"
              >
                {AREAS.map((a) => (
                  <option key={a.value} value={a.value} className="bg-card">
                    {a.label}
                  </option>
                ))}
              </select>
            </div>

            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              className={`flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition ${
                dragging ? 'border-brand bg-brand/5' : 'border-borderSoft'
              }`}
            >
              <UploadCloud className="h-8 w-8 text-brand" aria-hidden />
              <p className="text-sm text-textSecondary">
                Arraste um arquivo aqui ou{' '}
                <label htmlFor="file-input" className="cursor-pointer text-brand hover:text-brandHover">
                  procure no computador
                </label>
              </p>
              <input
                id="file-input"
                type="file"
                accept=".pdf,.csv,.xlsx,application/pdf,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="sr-only"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file && (
                <span className="flex items-center gap-2 rounded-lg border border-borderSoft bg-white/5 px-3 py-1.5 text-xs text-textPrimary">
                  <FileText className="h-3.5 w-3.5 text-brand" aria-hidden />
                  {file.name}
                </span>
              )}
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
                {error}
              </p>
            )}

            <button type="submit" disabled={submitting} className="btn-primary flex w-full items-center justify-center gap-2">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Enviar para análise
            </button>
          </form>

          <div className="glass-card rounded-3xl p-8">
            <h2 className="text-lg font-semibold">Seus documentos</h2>

            {loadingDocs ? (
              <div className="mt-6 flex items-center gap-2 text-sm text-textSecondary">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Carregando...
              </div>
            ) : documents.length === 0 ? (
              <p className="mt-6 text-sm text-textSecondary">Nenhum documento enviado ainda.</p>
            ) : (
              <ul className="mt-6 space-y-3">
                {documents.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center justify-between rounded-xl border border-borderSoft bg-white/5 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <FileText className="h-4 w-4 text-brand" aria-hidden />
                      <div>
                        <p className="text-sm">{doc.nome_original}</p>
                        <p className="text-xs text-textSecondary">
                          {AREAS.find((a) => a.value === doc.area_negocio)?.label ?? doc.area_negocio} ·{' '}
                          {doc.tipo.toUpperCase()}
                        </p>
                      </div>
                    </div>
                    <span className="rounded-full border border-borderSoft px-2.5 py-1 text-xs text-textSecondary">
                      {STATUS_LABEL[doc.status]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </main>
    </>
  );
}

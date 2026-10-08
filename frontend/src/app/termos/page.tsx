'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { apiJson } from '@/lib/api';
import { Navbar } from '@/components/Navbar';
import { TermsContent } from '@/components/TermsContent';

const TERMS_VERSION = process.env.NEXT_PUBLIC_TERMS_VERSION ?? '1.1.0';

export default function TermosPage() {
  const { user, loading, refreshProfile } = useAuth();
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const [textoPronto, setTextoPronto] = useState(false);
  const onCarregado = useCallback(() => setTextoPronto(true), []);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading) {
      if (!user) router.replace('/login');
      else if (user.terms_accepted) router.replace('/upload');
    }
  }, [user, loading, router]);

  const handleAccept = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await apiJson('/api/auth/accept-terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: TERMS_VERSION }),
      });
      await refreshProfile();
      router.push('/upload');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível registrar o aceite.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Navbar />
      <main className="section-container flex justify-center">
        <div className="glass-card w-full max-w-2xl rounded-3xl p-8 shadow-glow">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-6 w-6 text-brand" aria-hidden />
            <h1 className="section-title text-2xl md:text-3xl">Termo de Uso e Privacidade</h1>
          </div>
          <p className="mt-1 text-sm text-textSecondary">Versão {TERMS_VERSION}</p>

          <div className="mt-6 max-h-96 overflow-y-auto rounded-xl border border-borderSoft bg-white/5 p-5">
            <TermsContent onCarregado={onCarregado} />
          </div>

          <label className="mt-6 flex cursor-pointer items-start gap-3 text-sm text-textSecondary">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-borderSoft bg-white/5 accent-brand focus-ring"
            />
            Li e aceito o Termo de Uso e a Política de Privacidade.
          </label>

          {error && (
            <p role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            onClick={handleAccept}
            disabled={!checked || submitting || !textoPronto}
            className="btn-primary mt-6 flex w-full items-center justify-center gap-2"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Aceitar e continuar
          </button>
        </div>
      </main>
    </>
  );
}

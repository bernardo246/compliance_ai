import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { Navbar } from '@/components/Navbar';
import { TermsContent } from '@/components/TermsContent';

const TERMS_VERSION = process.env.NEXT_PUBLIC_TERMS_VERSION ?? '1.1.0';

// Página pública (sem login): o usuário precisa poder ler o termo ANTES de criar a conta.
export default function PrivacidadePage() {
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
          <div className="mt-6">
            <TermsContent />
          </div>
          <p className="mt-8 text-center text-sm text-textSecondary">
            <Link href="/register" className="text-brand hover:text-brandHover">
              Criar conta
            </Link>
            {' · '}
            <Link href="/login" className="text-brand hover:text-brandHover">
              Entrar
            </Link>
          </p>
        </div>
      </main>
    </>
  );
}

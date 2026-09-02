import type { Metadata } from 'next';
import { AuthProvider } from '@/lib/auth-context';
import './globals.css';

export const metadata: Metadata = {
  title: 'Plataforma de Análise de Documentos com IA',
  description: 'Análise e compliance de documentos com IA, por área de negócio.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body className="relative min-h-screen bg-bg font-sans text-textPrimary antialiased">
        <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 bg-grid opacity-40" />
        <div
          aria-hidden
          className="pointer-events-none fixed -left-20 -top-20 -z-10 h-72 w-72 rounded-full bg-brand/20 blur-3xl"
        />
        <div
          aria-hidden
          className="pointer-events-none fixed -bottom-20 -right-20 -z-10 h-72 w-72 rounded-full bg-brand/20 blur-3xl"
        />
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}

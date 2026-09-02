'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileStack, LogOut } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';

export function Navbar() {
  const { user, logout } = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    await logout();
    router.push('/login');
  };

  return (
    <header className="sticky top-0 z-20 border-b border-borderSoft bg-bg/80 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4 md:px-10">
        <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-wide">
          <FileStack className="h-5 w-5 text-brand" aria-hidden />
          Análise IA
        </Link>

        {user && (
          <div className="flex items-center gap-6">
            <span className="hidden text-sm text-textSecondary sm:inline">{user.email}</span>
            <button
              onClick={handleLogout}
              className="nav-link flex items-center gap-1.5"
              aria-label="Sair da conta"
            >
              <LogOut className="h-4 w-4" aria-hidden />
              Sair
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

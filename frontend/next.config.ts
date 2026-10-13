import type { NextConfig } from 'next';

// BACKEND_URL (opcional): endereço do backend (ex.: https://xxxx.trycloudflare.com). Quando definido, o
// Next repassa /api/* para ele, e o navegador fala só com o endereço do frontend. Isso serve para usar o
// frontend na Vercel sem domínio próprio: com frontend e API em sites diferentes, o cookie do refresh
// token (SameSite=strict) não seria enviado. Use junto com NEXT_PUBLIC_API_URL=same-origin.
// Lido no BUILD: mudou o endereço do backend, é preciso um novo deploy.
const backendUrl = process.env.BACKEND_URL?.trim().replace(/\/$/, '');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return backendUrl ? [{ source: '/api/:path*', destination: `${backendUrl}/api/:path*` }] : [];
  },
};

export default nextConfig;

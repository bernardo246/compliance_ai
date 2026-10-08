export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// access token vive só em memória (não em localStorage) — mitiga XSS.
// O refresh token vive em cookie httpOnly, setado pelo backend.
let accessToken: string | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken() {
  return accessToken;
}

interface ApiError {
  statusCode: number;
  message: string | string[];
}

// O refresh token é de USO ÚNICO no backend: duas renovações simultâneas com o
// mesmo cookie fazem a segunda ser tratada como reuso (e derrubam a sessão).
// Dois níveis de proteção:
//  1. Na MESMA aba só existe UMA renovação em andamento por vez: quem chegar
//     enquanto ela corre (várias chamadas com 401 ao mesmo tempo, o efeito
//     duplicado do StrictMode) espera e usa o mesmo resultado.
//  2. Entre ABAS do mesmo navegador (que dividem o cookie) as renovações se
//     revezam por um lock (Web Locks API): a aba que espera só envia a sua
//     requisição depois que a outra terminou, já com o cookie novo.
let refreshInFlight: Promise<string | null> | null = null;

const REFRESH_LOCK_NAME = 'compliance-refresh-token';

function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  // Navegador sem Web Locks: segue só com a proteção da própria aba.
  return locks ? (locks.request(REFRESH_LOCK_NAME, fn) as Promise<T>) : fn();
}

async function doRefresh(): Promise<string | null> {
  const res = await fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json();
  setAccessToken(data.accessToken);
  return data.accessToken as string;
}

export function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = withRefreshLock(doRefresh)
      .catch(() => null)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const doFetch = (token: string | null) =>
    fetch(`${API_URL}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        ...(init.headers ?? {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

  let res = await doFetch(accessToken);

  // Access token expirado (15min) — tenta renovar uma vez com o refresh cookie.
  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      res = await doFetch(newToken);
    }
  }

  return res;
}

export async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = data as ApiError | null;
    const message = Array.isArray(err?.message)
      ? err!.message.join(' ')
      : err?.message ?? 'Erro inesperado ao comunicar com o servidor.';
    throw new Error(message);
  }

  return data as T;
}

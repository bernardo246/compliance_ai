const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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

async function refreshAccessToken(): Promise<string | null> {
  const res = await fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) return null;
  const data = await res.json();
  setAccessToken(data.accessToken);
  return data.accessToken;
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

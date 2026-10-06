/**
 * Teste OFFLINE da renovação de login com VÁRIAS ABAS do mesmo navegador.
 *
 * Simula um servidor com a regra real (refresh token de uso único, reivindicação
 * atômica, reuso derruba a família), um cookie COMPARTILHADO e N "abas" (cópias
 * independentes do módulo frontend/src/lib/api.ts, cada uma com o seu estado).
 *   - controle, SEM Web Locks: duas abas renovando ao mesmo tempo derrubam a sessão
 *   - com Web Locks: as abas se revezam e todas conseguem renovar, a sessão fica de pé
 */
const API = require.resolve('../../frontend/src/lib/api');

const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- servidor simulado + cookie compartilhado --------------------------------
let tokens = new Map<string, { revoked: boolean }>();
let contador = 1;
const jar = { token: 'T1' };
let requisicoes = 0;

function servidor(cookie: string): { status: number; accessToken?: string } {
  const t = tokens.get(cookie);
  if (!t) return { status: 401 };
  if (t.revoked) {
    for (const v of tokens.values()) v.revoked = true; // reuso: revoga a família
    return { status: 401 };
  }
  t.revoked = true; // reivindicação atômica (um único chamador consegue)
  contador++;
  const novo = `T${contador}`;
  tokens.set(novo, { revoked: false });
  jar.token = novo; // Set-Cookie: o navegador troca o cookie para todas as abas
  return { status: 200, accessToken: `access-${novo}` };
}

(globalThis as any).fetch = async () => {
  requisicoes++;
  const cookie = jar.token; // o navegador anexa o cookie VIGENTE na hora do envio
  await sleep(25); // a requisição está "em voo"
  const r = servidor(cookie);
  return { ok: r.status === 200, status: r.status, json: async () => ({ accessToken: r.accessToken }) };
};

// ---- locks entre abas -------------------------------------------------------------
function instalarLocks(ativo: boolean) {
  const filas = new Map<string, Promise<unknown>>();
  const locks = ativo
    ? {
        request: (nome: string, fn: () => Promise<unknown>) => {
          const anterior = filas.get(nome) ?? Promise.resolve();
          const rodar = anterior.then(fn, fn);
          filas.set(nome, rodar.catch(() => undefined));
          return rodar;
        },
      }
    : undefined;
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
}

function abrirAba(): { refreshAccessToken: () => Promise<string | null> } {
  delete require.cache[API]; // módulo novo = aba nova, com estado próprio
  return require(API);
}

async function cenario(comLocks: boolean, abas: number, chamadasPorAba = 1) {
  tokens = new Map([['T1', { revoked: false }]]);
  contador = 1;
  jar.token = 'T1';
  requisicoes = 0;
  instalarLocks(comLocks);
  const tabs = Array.from({ length: abas }, abrirAba);
  const resp = await Promise.all(tabs.flatMap((t) => Array.from({ length: chamadasPorAba }, () => t.refreshAccessToken())));
  const sucessos = resp.filter((r) => r !== null).length;
  const sessaoViva = tokens.get(jar.token)?.revoked === false;
  return { sucessos, total: resp.length, sessaoViva, requisicoes };
}

async function main() {
  const controle = await cenario(false, 2);
  check('CONTROLE sem Web Locks: 2 abas renovando juntas derrubam a sessão', !controle.sessaoViva && controle.sucessos < 2, `${controle.sucessos} de ${controle.total} renovaram, sessão viva: ${controle.sessaoViva}`);

  const duas = await cenario(true, 2);
  check('com Web Locks: 2 abas renovando juntas conseguem as duas', duas.sucessos === 2 && duas.sessaoViva, `${duas.sucessos} de ${duas.total}, sessão viva: ${duas.sessaoViva}`);

  const cinco = await cenario(true, 5);
  check('com Web Locks: 5 abas ao mesmo tempo conseguem as cinco', cinco.sucessos === 5 && cinco.sessaoViva, `${cinco.sucessos} de ${cinco.total}, sessão viva: ${cinco.sessaoViva}`);

  const mistura = await cenario(true, 3, 4);
  check('3 abas com 4 chamadas cada: 1 requisição por aba (3) e a sessão de pé', mistura.sucessos === 12 && mistura.requisicoes === 3 && mistura.sessaoViva, `${mistura.sucessos} de ${mistura.total} receberam token, ${mistura.requisicoes} requisição(ões) ao servidor`);

  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('FALHA:', e instanceof Error ? e.stack : e); process.exit(1); });

/**
 * Teste OFFLINE da renovação única do frontend (frontend/src/lib/api.ts):
 * o refresh token é de uso único no backend, então várias renovações
 * simultâneas precisam virar UMA requisição.
 */
import { apiFetch, getAccessToken, refreshAccessToken, setAccessToken } from '../../frontend/src/lib/api';

const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

let chamadasRefresh = 0;
let tokenAtual = 'token-novo-1';
let refreshFalha = false;

(globalThis as any).fetch = async (url: string, init: any = {}) => {
  if (String(url).endsWith('/api/auth/refresh')) {
    chamadasRefresh++;
    await new Promise((r) => setTimeout(r, 30));
    if (refreshFalha) return { ok: false, status: 401, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ accessToken: tokenAtual }) };
  }
  const auth = init.headers?.Authorization;
  return auth === `Bearer ${tokenAtual}`
    ? { ok: true, status: 200, json: async () => ({ ok: true }) }
    : { ok: false, status: 401, json: async () => ({}) };
};

async function main() {
  const resultadoUnico = await Promise.all(Array.from({ length: 6 }, () => refreshAccessToken()));
  check('6 renovações simultâneas viram 1 única requisição', chamadasRefresh === 1, `${chamadasRefresh} chamada(s)`);
  check('todas recebem o mesmo token', resultadoUnico.every((t) => t === 'token-novo-1'));

  chamadasRefresh = 0;
  setAccessToken('token-expirado');
  const respostas = await Promise.all(Array.from({ length: 5 }, () => apiFetch('/api/documents')));
  check('5 chamadas de API com token expirado (401) fazem 1 só renovação', chamadasRefresh === 1, `${chamadasRefresh} chamada(s)`);
  check('...e todas são refeitas com o token novo e dão certo', respostas.every((r) => r.status === 200));

  chamadasRefresh = 0;
  tokenAtual = 'token-novo-2';
  await refreshAccessToken();
  await refreshAccessToken();
  check('renovações em sequência (não simultâneas) fazem uma requisição cada', chamadasRefresh === 2, `${chamadasRefresh} chamada(s)`);
  check('o token novo é guardado', getAccessToken() === 'token-novo-2');

  refreshFalha = true;
  chamadasRefresh = 0;
  const falhas = await Promise.all([refreshAccessToken(), refreshAccessToken(), refreshAccessToken()]);
  check('renovação recusada (401): todas recebem null, com 1 requisição só', falhas.every((t) => t === null) && chamadasRefresh === 1, `${chamadasRefresh} chamada(s)`);
  refreshFalha = false;
  tokenAtual = 'token-novo-3';
  const depois = await refreshAccessToken();
  check('depois de uma falha, a próxima renovação funciona (a trava é liberada)', depois === 'token-novo-3');

  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('FALHA:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
